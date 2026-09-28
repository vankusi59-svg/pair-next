/**
 * P9 DEVIN executor — Devin REST API (v1 sessions create/inspect/message)
 * behind the canonical ExecutorAdapter contract.
 *
 * In this environment Devin is only programmatically reachable via
 * `https://api.devin.ai` with a Bearer `cog_...` credential; the local
 * `/opt/.devin/binaries/devin` binary is the editor CLI, not a task API.
 *
 * Canonical invariants:
 *  - PAIR execution ids stay canonical (`workerExecutionId` over the
 *    governed task id); Devin session ids are supplemental remote refs only.
 *  - Dispatch writes a run_root journal BEFORE returning so restart/crash
 *    rehydrates exactly and never double-dispatches.
 *  - Remote artifacts (session url, PR url) are refs in the result payload,
 *    never declared filesystem artifacts — the artifact validator only sees
 *    files produced under allowed_paths.
 *  - `fetchFn` is injectable (synchronous signature) so deterministic tests
 *    never hit the network; the default transport is `curl` with the key
 *    passed through a stdin config file — never on argv or in logs.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IntegrityError, NotFoundError, PolicyError } from "./errors.js";
import { atomicWriteJson, utcnow, workerExecutionId } from "./canonical.js";
import type { ExecutorAdapter } from "./adapter.js";

export const DEVIN_EXECUTOR_ID = "DEVIN";
export const DEVIN_CAPABILITIES = [
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
] as const;

export const DEVIN_TRANSPORT = "REMOTE_API";
export const DEVIN_ROUTE_ID = "RTE_DEVIN_API";
export const DEVIN_BINDING_MECHANISM = "AMBIENT_FIXED";

const DEFAULT_BASE_URL = "https://api.devin.ai";
const DEFAULT_ORG_ID = "org-95faaf8c42dc4b2eb6d9e17a5fc5fe90";
const DEFAULT_DEVIN_MODE = "swe-2-max";
const DEVIN_MODE_FALLBACK = "swe-2-high";
/** Remote sessions mapped to non-terminal states (e.g. `blocked` awaiting
 *  input) cannot hold a mission task open forever — past this deadline the
 *  execution is reported TIMEOUT and recovery takes over. */
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;

export interface DevinResponse {
  status: number;
  data: Record<string, unknown>;
}
/** Synchronous request transport — tests inject a stub. */
export type DevinFetch = (
  method: string,
  url: string,
  body: Record<string, unknown> | undefined,
  authHeader: string | null,
) => DevinResponse;

export interface DevinAdapterDeps {
  journalRoot: string;
  /** Defaults: env PAIR_DEVIN_API_KEY. */
  apiKey?: string | null;
  /** Defaults: env PAIR_DEVIN_ORG_ID → DEFAULT_ORG_ID. */
  orgId?: string;
  /** Devin agent mode pinned on dispatched sessions. Defaults: env
   *  PAIR_DEVIN_MODE → "swe-2-max". If the API rejects the mode
   *  (not enabled for the org), dispatch retries once with the
   *  fallback mode "swe-2-high". */
  devinMode?: string;
  /** Defaults: https://api.devin.ai */
  baseUrl?: string;
  /** Injectable synchronous transport — omit to use the curl transport. */
  fetchFn?: DevinFetch;
  /** Max wall-clock a remote session may stay non-terminal before the
   *  execution reports TIMEOUT. Defaults: env PAIR_DEVIN_TASK_TIMEOUT_MS
   *  → 15 minutes. */
  taskTimeoutMs?: number;
  now?: () => string;
  /** Injectable epoch-ms clock for timeout checks — defaults Date.now. */
  nowMs?: () => number;
  /**
   * Cost guard evaluated before any remote session is created. Returning
   * `{allowed:false}` settles the dispatch FAILED with error class
   * BUDGET_EXCEEDED — recovery escalates to the operator instead of spending.
   */
  costGuard?: () => { allowed: boolean; reason?: string };
  /** Grace window before a `blocked` remote session counts as
   *  REMOTE_INPUT_REQUIRED. `blocked` is also emitted transiently when a
   *  session's turn ends (waiting-for-user before `finished` flips) — failing
   *  instantly kills completed-in-substance work. Defaults: env
   *  PAIR_DEVIN_BLOCKED_GRACE_MS → 120000. */
  blockedGraceMs?: number;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

/** Completion sentinel the governed prompt requires the remote agent to
 *  reply with ("…then reply DONE"). observe() treats a `blocked` session
 *  whose last devin_message ends in this sentinel as COMPLETED — the enum
 *  stays `blocked` while the finished session idles waiting for the next
 *  user message, which can outlast any grace window. Checked as a
 *  standalone line in the message tail (attachments may follow it). */
const DONE_RE = /^\s*DONE\s*$/m;

function lastDevinMessage(data: Record<string, unknown>): string | null {
  const msgs = data.messages;
  if (!Array.isArray(msgs)) return null;
  const last = [...(msgs as Array<Record<string, unknown>>)]
    .reverse()
    .find((m) => String(m.type) === "devin_message");
  const text = last ? String(last.message ?? "") : "";
  return text || null;
}

function mapStatus(statusEnum: string): string {
  const s = statusEnum.toLowerCase();
  if (s === "finished") return "COMPLETED";
  if (s === "blocked") return "FAILED";
  if (s === "working" || s === "resumed") return "RUNNING";
  if (s === "expired" || s.startsWith("suspend")) return "FAILED";
  return "RUNNING";
}

/** curl transport — credential travels in a stdin config, never argv. */
const curlFetch: DevinFetch = (method, url, body, authHeader) => {
  const args = ["-sS", "-K", "-", "-o", "-", "-w", "\n%{http_code}", "-X", method];
  args.push(url);
  const config = [
    `header = "Content-Type: application/json"`,
    authHeader ? `header = "${authHeader}"` : null,
    body ? `data = ${JSON.stringify(JSON.stringify(body))}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const out = execFileSync("curl", args, {
      input: config,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    const idx = out.lastIndexOf("\n");
    const status = Number(out.slice(idx + 1).trim()) || 0;
    const text = out.slice(0, idx);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text.slice(0, 512) };
    }
    return { status, data };
  } catch (error) {
    return { status: 0, data: { error: String((error as Error).message).slice(0, 200) } };
  }
};

export class DevinExecutorAdapter implements ExecutorAdapter {
  readonly executor_id = DEVIN_EXECUTOR_ID;
  readonly runtime_type = "REMOTE_CLOUD";
  private readonly executions = new Map<string, Record<string, unknown>>();
  private readonly apiKey: string | null;
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly devinMode: string;
  private readonly fetchFn: DevinFetch;
  private readonly taskTimeoutMs: number;
  private readonly blockedGraceMs: number;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly journalRoot: string;
  private readonly costGuard?: () => { allowed: boolean; reason?: string };

  constructor(deps: DevinAdapterDeps) {
    this.apiKey = deps.apiKey ?? process.env.PAIR_DEVIN_API_KEY ?? null;
    this.orgId = deps.orgId ?? process.env.PAIR_DEVIN_ORG_ID ?? DEFAULT_ORG_ID;
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    this.devinMode = deps.devinMode ?? process.env.PAIR_DEVIN_MODE ?? DEFAULT_DEVIN_MODE;
    this.fetchFn = deps.fetchFn ?? curlFetch;
    this.taskTimeoutMs =
      deps.taskTimeoutMs ?? (Number(process.env.PAIR_DEVIN_TASK_TIMEOUT_MS ?? 0) || DEFAULT_TASK_TIMEOUT_MS);
    this.blockedGraceMs =
      deps.blockedGraceMs ?? (Number(process.env.PAIR_DEVIN_BLOCKED_GRACE_MS ?? 0) || 120_000);
    this.now = deps.now ?? utcnow;
    this.nowMs = deps.nowMs ?? Date.now;
    this.journalRoot = deps.journalRoot;
    this.costGuard = deps.costGuard;
    fs.mkdirSync(deps.journalRoot, { recursive: true });
  }

  private readRunRoot(executionId: string): Record<string, unknown> | null {
    const p = path.join(this.journalRoot, executionId, "devin-dispatch.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  }

  private api(
    method: string,
    urlPath: string,
    body?: Record<string, unknown>,
  ): DevinResponse {
    if (!this.apiKey) {
      return { status: 401, data: { error: "DEVIN_CREDENTIAL_NOT_RESOLVABLE" } };
    }
    return this.fetchFn(
      method,
      `${this.baseUrl}${urlPath}`,
      body,
      `Authorization: Bearer ${this.apiKey}`,
    );
  }

  /* ---------------- probe / qualify / health ----------------------------- */

  probe(): Record<string, unknown> {
    if (!this.apiKey) {
      return {
        executor_id: this.executor_id,
        available: false,
        state: "DEGRADED",
        reason: "DEVIN_CREDENTIAL_NOT_RESOLVABLE",
        env_var_name: "PAIR_DEVIN_API_KEY",
      };
    }
    return {
      executor_id: this.executor_id,
      available: true,
      state: "READY",
      transport: DEVIN_TRANSPORT,
      base_url: this.baseUrl,
      org_id: this.orgId,
    };
  }

  qualify(): Record<string, unknown> {
    const probe = this.probe();
    const qualified = probe.available === true;
    return {
      executor_id: this.executor_id,
      qualified,
      dispatch_enabled: qualified,
      transport: DEVIN_TRANSPORT,
      reasons: qualified ? [] : [String(probe.reason ?? "UNQUALIFIED")],
      workspace_binding: "EXPLICIT_WORKSPACE",
    };
  }

  capabilities(): Record<string, unknown> {
    const q = this.qualify();
    return {
      executor_id: this.executor_id,
      capability_ids: [...DEVIN_CAPABILITIES],
      qualified: q.qualified,
      dispatch_enabled: q.dispatch_enabled,
    };
  }

  health(): Record<string, unknown> {
    const q = this.qualify();
    return {
      executor_id: this.executor_id,
      state: q.qualified ? "READY" : "DEGRADED",
      active_executions: [...this.executions.values()].filter(
        (e) => !TERMINAL.has(String(e.status)),
      ).length,
    };
  }

  /* ---------------- task lifecycle --------------------------------------- */

  prepare_task(task: Record<string, unknown>): Record<string, unknown> {
    for (const f of ["governed_task_id", "mission_id", "task_id", "workspace", "correlation_id"]) {
      if (!task[f]) {
        throw new IntegrityError("FAIL_CLOSED_GOVERNED_TASK_CONTRACT_INCOMPLETE", f);
      }
    }
    const q = this.qualify();
    if (!q.qualified) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    return {
      executor_id: this.executor_id,
      prepared: true,
      expected_execution_id: workerExecutionId(this.executor_id, String(task.governed_task_id)),
    };
  }

  private buildPrompt(task: Record<string, unknown>): string {
    const allowed = (task.allowed_paths as string[]) ?? [task.workspace];
    const lines = [
      `PAIR governed task ${String(task.task_id)} of mission ${String(task.mission_id)}.`,
      `Instruction: ${String(task.task_instruction ?? task.title ?? "")}`,
      `Workspace confinement: operate only inside ${String(task.workspace)}; allowed paths: ${allowed.join(", ")}.`,
      "Do not access unrelated credentials, environment variables, or paths outside the authorized scope.",
      `Correlation: ${String(task.correlation_id)}`,
    ];
    // File-deliverable return path: when the operator configured an outbox
    // endpoint, remote artifacts (chart screenshots, report files) are pushed
    // back over it — files written to the remote workspace stay remote and
    // would otherwise be unreachable. The token is upload-only by design.
    const outboxUrl = process.env.PAIR_OUTBOX_URL;
    const outboxToken = process.env.PAIR_OUTBOX_TOKEN;
    if (outboxUrl && outboxToken) {
      lines.push(
        `File deliverables: if the instruction asks for a chart, screenshot, or any file the operator must receive, upload each via: curl -X POST "${outboxUrl}/api/outbox" -H "x-outbox-token: ${outboxToken}" -H "content-type: application/json" -d '{"mission_id":"${String(task.mission_id)}","task_id":"${String(task.task_id)}","filename":"<name>.png","data_base64":"<base64 content>"}'. Allowed: png/jpg/jpeg/webp/gif/md/txt, max 8MB. Do this BEFORE replying DONE.`,
      );
    }
    return lines.join("\n");
  }

  dispatch(
    task: Record<string, unknown>,
    _context?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const q = this.qualify();
    if (!q.qualified) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    if (task.executor_id !== this.executor_id) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH", String(task.executor_id));
    }
    if (task.governance_state !== "DISPATCH_AUTHORIZED" || task.dispatch_enabled !== true) {
      throw new IntegrityError(
        "FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED",
        String(task.governance_state),
      );
    }
    const executionId = workerExecutionId(this.executor_id, String(task.governed_task_id));
    // Rehydrate before dispatching — never double-dispatch after restart.
    const journal = this.readRunRoot(executionId);
    if (journal?.record) {
      const rec = { ...(journal.record as Record<string, unknown>) };
      this.executions.set(executionId, rec);
      const { result: _omit, ...out } = rec;
      return out;
    }
    const existing = this.executions.get(executionId);
    if (existing) {
      const { result: _omit, ...out } = existing;
      return { ...out };
    }
    // Cost guard: no remote session is created when the operator-configured
    // budget/halt check rejects — the dispatch settles FAILED immediately.
    const guard = this.costGuard?.();
    if (guard && !guard.allowed) {
      const runRoot0 = path.join(this.journalRoot, executionId);
      fs.mkdirSync(runRoot0, { recursive: true });
      const record: Record<string, unknown> = {
        executor_id: this.executor_id,
        execution_id: executionId,
        mission_id: task.mission_id,
        task_id: task.task_id,
        governed_task_id: task.governed_task_id,
        correlation_id: task.correlation_id,
        workspace: task.workspace,
        status: "FAILED",
        started_at: this.now(),
        finished_at: this.now(),
        remote_session_id: null,
        remote_url: null,
        budget_rejection: guard.reason ?? "cost guard rejected dispatch",
      };
      this.executions.set(executionId, record);
      atomicWriteJson(path.join(runRoot0, "devin-dispatch.json"), {
        record,
        remote_session_id: null,
      });
      return { ...record };
    }
    const body = (mode: string): Record<string, unknown> => ({
      prompt: this.buildPrompt(task),
      idempotent: true,
      tags: ["pair-os", String(task.mission_id)],
      title: `PAIR ${String(task.task_key ?? task.task_id)}`,
      devin_mode: mode,
    });
    let res = this.api("POST", `/v1/sessions`, body(this.devinMode));
    let usedMode = this.devinMode;
    if (res.status === 400 && this.devinMode !== DEVIN_MODE_FALLBACK) {
      res = this.api("POST", `/v1/sessions`, body(DEVIN_MODE_FALLBACK));
      usedMode = DEVIN_MODE_FALLBACK;
    }
    if (res.status === 401 || res.status === 403) {
      throw new PolicyError("DEVIN_CREDENTIAL_NOT_RESOLVABLE", `http_${res.status}`);
    }
    if (res.status >= 400 || res.status === 0) {
      throw new PolicyError("FAIL_CLOSED_DEVIN_DISPATCH_REJECTED", `http_${res.status}`);
    }
    const runRoot = path.join(this.journalRoot, executionId);
    fs.mkdirSync(runRoot, { recursive: true });
    const rawId = String(res.data.session_id ?? res.data.devin_id ?? "");
    const sessionId = rawId.startsWith("devin-") ? rawId.slice(6) : rawId;
    const record: Record<string, unknown> = {
      executor_id: this.executor_id,
      execution_id: executionId,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      correlation_id: task.correlation_id,
      workspace: task.workspace,
      run_root: runRoot,
      status: "RUNNING",
      started_at: this.now(),
      finished_at: null,
      remote_session_id: sessionId ? `devin-${sessionId}` : null,
      remote_url: res.data.url ?? null,
      remote_devin_mode: usedMode,
    };
    this.executions.set(executionId, record);
    atomicWriteJson(path.join(runRoot, "devin-dispatch.json"), {
      record,
      remote_session_id: record.remote_session_id,
    });
    return { ...record };
  }

  observe(executionId: string): Record<string, unknown> {
    const rec = this.requireRecord(executionId);
    if (TERMINAL.has(String(rec.status))) {
      const { result: _omit, ...out } = rec;
      return { ...out };
    }
    const remoteId = String(rec.remote_session_id ?? "");
    if (!remoteId) return { ...rec };
    const startedMs = Date.parse(String(rec.started_at ?? ""));
    if (Number.isFinite(startedMs) && this.nowMs() - startedMs > this.taskTimeoutMs) {
      rec.status = "TIMEOUT";
      rec.finished_at = this.now();
      rec.remote_timeout_ms = this.taskTimeoutMs;
      this.executions.set(executionId, rec);
      const { result: _t, ...out } = rec;
      return { ...out };
    }
    const res = this.api("GET", `/v1/sessions/${remoteId}`);
    if (res.status === 404) {
      rec.status = "UNKNOWN";
      rec.finished_at = this.now();
    } else if (res.status < 400) {
      const statusEnum = String(res.data.status_enum ?? res.data.status ?? "");
      if (statusEnum === "blocked") {
        // `blocked` covers both "agent needs operator input" and "agent's
        // turn ended; session sits waiting for the next user message" — the
        // enum may stay `blocked` for minutes after the deliverable lands.
        // Disambiguate by the DONE sentinel the governed prompt requires:
        // a completed reply means COMPLETED regardless of enum lag; anything
        // else gets a grace window before REMOTE_INPUT_REQUIRED escalation.
        rec.remote_status_enum = "blocked";
        const lastMsg = lastDevinMessage(res.data);
        if (lastMsg && DONE_RE.test(lastMsg.slice(-2000))) {
          rec.status = "COMPLETED";
          rec.remote_status_enum = "blocked(done)";
          rec.finished_at = this.now();
        } else {
          if (!rec.blocked_since) rec.blocked_since = this.now();
          const blockedMs = this.nowMs() - Date.parse(String(rec.blocked_since));
          if (Number.isFinite(blockedMs) && blockedMs > this.blockedGraceMs) {
            rec.status = "FAILED";
            rec.finished_at = this.now();
          }
        }
      } else if (statusEnum) {
        delete rec.blocked_since;
        rec.status = mapStatus(statusEnum);
        rec.remote_status_enum = statusEnum;
        if (TERMINAL.has(String(rec.status))) rec.finished_at = this.now();
      }
    }
    this.executions.set(executionId, rec);
    const { result: _omit, ...out } = rec;
    return { ...out };
  }

  cancel(executionId: string): Record<string, unknown> {
    const rec = this.requireRecord(executionId);
    const remoteId = String(rec.remote_session_id ?? "");
    if (remoteId && this.apiKey) {
      const res = this.api("POST", `/v1/sessions/${remoteId}/messages`, {
        message: "PAIR operator cancellation: stop work on this task now.",
      });
      if (res.status >= 400) rec.cancel_request_failed = true;
    }
    rec.status = "CANCELLED";
    rec.finished_at = this.now();
    rec.cancelled_by = "PAIR_OPERATOR";
    this.executions.set(executionId, rec);
    const { result: _omit, ...out } = rec;
    return { ...out };
  }

  collect_result(executionId: string): Record<string, unknown> {
    const rec = this.requireRecord(executionId);
    if (rec.result) return rec.result as Record<string, unknown>;
    const remoteId = String(rec.remote_session_id ?? "");
    let remoteDetail: Record<string, unknown> = {};
    if (remoteId && this.apiKey) {
      const res = this.api("GET", `/v1/sessions/${remoteId}`);
      if (res.status < 400) remoteDetail = res.data;
    }
    const status = TERMINAL.has(String(rec.status)) ? String(rec.status) : "UNKNOWN";
    const result: Record<string, unknown> = {
      schema: "pair.os.worker-result.v1",
      status: status === "UNKNOWN" ? "FAILED" : status,
      execution_id: executionId,
      worker_execution_id: executionId,
      mission_id: rec.mission_id,
      task_id: rec.task_id,
      governed_task_id: rec.governed_task_id,
      correlation_id: rec.correlation_id,
      started_at: rec.started_at,
      completed_at: rec.finished_at ?? this.now(),
      // The deliverable for remote tasks is the agent's reply text — prefer
      // structured_output, else the last devin_message (v1 returns messages
      // inline; the standalone /messages endpoint does not exist), else the
      // status enum.
      output:
        remoteDetail.structured_output ??
        lastDevinMessage(remoteDetail) ??
        remoteDetail.status_enum ??
        null,
      artifacts: [],
      remote_refs: {
        session_id: remoteId || null,
        session_url: remoteDetail.url ?? rec.remote_url ?? null,
        pull_request: remoteDetail.pull_request ?? null,
      },
      error:
        status === "COMPLETED"
          ? null
          : rec.budget_rejection
            ? { class: "BUDGET_EXCEEDED", detail: String(rec.budget_rejection) }
          : rec.remote_status_enum === "blocked"
            ? {
                class: "REMOTE_INPUT_REQUIRED",
                detail: `remote session blocked awaiting operator input: ${remoteDetail.url ?? rec.remote_url ?? remoteId}`,
              }
            : { class: "DEVIN_REMOTE", detail: String(remoteDetail.status_enum ?? rec.status) },
      provenance: {
        producer: this.executor_id,
        transport: DEVIN_TRANSPORT,
        pair_execution_id: executionId,
      },
    };
    rec.result = result;
    rec.status = result.status;
    if (!rec.finished_at) rec.finished_at = this.now();
    this.executions.set(executionId, rec);
    return result;
  }

  collect_artifacts(executionId: string): Array<Record<string, unknown>> {
    const result = this.collect_result(executionId);
    return (result.artifacts as Array<Record<string, unknown>>) ?? [];
  }

  dispatch_evidence(governedTaskId: string): { dispatched: boolean; execution_id?: string } {
    const executionId = workerExecutionId(this.executor_id, governedTaskId);
    const journal = this.readRunRoot(executionId);
    if (journal?.remote_session_id) {
      return { dispatched: true, execution_id: executionId };
    }
    return { dispatched: false };
  }

  private requireRecord(executionId: string): Record<string, unknown> {
    let rec = this.executions.get(executionId);
    if (!rec) {
      const journal = this.readRunRoot(executionId);
      if (journal?.record) {
        rec = journal.record as Record<string, unknown>;
        this.executions.set(executionId, rec);
      }
    }
    if (!rec) throw new NotFoundError(`execution:${executionId}`);
    return rec;
  }
}
