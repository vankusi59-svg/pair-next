/**
 * ceo-decision — the CEO_DECISION invocation contract + invoker seam (P15.3).
 *
 * CEO_DECISION is an INVOCATION ROLE, not a new model_role_assignment: the
 * same canonical model may serve PLANNER_COORDINATOR and CEO_DECISION with
 * separate prompts, context, schema, attempt evidence, controller, and
 * authority boundary. The Planner↔DSH disjointness invariant is untouched;
 * a canonically DSH_EXECUTION model/alias may never serve CEO_DECISION.
 *
 * The model is proposal-only. It never owns state, never selects
 * executors, never mutates anything — the deterministic controller
 * (ceo-planning-cycle.ts) owns parsing, policy, and all authority.
 */

import { digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { extractPlanJson } from "./llm-planner.js";
import { providerEntryId } from "./provider-catalog.js";
import type { PairEvidenceStore } from "./store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_CLI_ENDPOINT,
  CODEX_CLI_PROTOCOL_FAMILY,
  CODEX_CLI_PROVIDER_ID,
  CODEX_CLI_WARNING,
  classifyCodexCliExit,
  invokeCodexCli,
  resolveCodexExecutable,
  type CodexCliEnv,
} from "./codex-cli-transport.js";

export const CEO_DECISION_SCHEMA = "pair.ceo-decision.v1";
export const CEO_OBSERVATION_SCHEMA = "pair.ceo-observation.v1";

export const CEO_DECISION_KIND = {
  INITIALIZE_WORKSTREAMS: "INITIALIZE_WORKSTREAMS",
  PRIORITIZE_EXISTING: "PRIORITIZE_EXISTING",
  WAIT: "WAIT",
} as const;
export type CeoDecisionKind =
  (typeof CEO_DECISION_KIND)[keyof typeof CEO_DECISION_KIND];

export const CEO_WAIT_REASONS = new Set<string>([
  "AWAITING_PROGRESS",
  "NO_ACTIONABLE_GAP",
  "DEPENDENCIES_BLOCKED",
  "INSUFFICIENT_VERIFIED_PROGRESS",
]);

/** Explicitly forbidden R1 decision vocabulary — a model emitting any of
 *  these is rejected WHOLE; unauthorized actions are never stripped and
 *  the remainder accepted. */
export const CEO_FORBIDDEN_DECISION_KINDS = new Set<string>([
  "ADD_WORKSTREAM",
  "REMOVE_WORKSTREAM",
  "REPLAN",
  "CANCEL_WORKSTREAM",
  "PAUSE_WORKSTREAM",
  "RESUME_WORKSTREAM",
  "ASSIGN_AGENT",
  "DELEGATE",
  "OPEN_WORK_ITEM",
  "CREATE_MISSION",
  "SELECT_EXECUTOR",
  "SELECT_MODEL",
  "CHANGE_BUDGET",
  "CHANGE_KPI",
  "CHANGE_OBJECTIVE",
  "SEND_TELEGRAM",
  "CALL_PLANNER",
  "CALL_BRAIN",
]);

export const CEO_MAX_SUMMARY_LEN = 512;
export const CEO_MAX_OUTPUT_BYTES = 64 * 1024;
/** Serialized observation/user-prompt bound BEFORE any invocation —
 *  UTF-8 bytes, never JS character count. Oversized state fails closed
 *  (never truncated to fit). */
export const CEO_MAX_OBSERVATION_BYTES = 96 * 1024;
export const CEO_DEFAULT_TIMEOUT_MS = 20000;
/** Default CEO reasoning model on the codex-cli provider (P15.3 R2
 *  addendum §D) — the same canonical `codex-cli:<model>` entry may serve
 *  PLANNER_COORDINATOR and CEO_DECISION without a second authority. */
export const CEO_CODEX_DEFAULT_MODEL = "gpt-6.1-sol";

export interface CeoProposalWorkstream {
  workstream_key: string;
  title: string;
  goal: string;
  depends_on_keys?: string[];
}

/** The strictly-typed proposal the deterministic gate consumes. */
export interface CeoProposal {
  decision_kind: CeoDecisionKind;
  workstreams?: CeoProposalWorkstream[];
  priority_order?: string[];
  wait_reason?: string;
  summary?: string;
}

function invalid(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_CEO_DECISION_INVALID", detail);
}
function forbidden(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_CEO_DECISION_FORBIDDEN", detail);
}

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "decision_kind",
  "workstreams",
  "priority_order",
  "wait_reason",
  "summary",
]);
const WORKSTREAM_KEYS = new Set([
  "workstream_key",
  "title",
  "goal",
  "depends_on_keys",
]);

/**
 * THE ONE canonical proposal-shape authority (R2.B) — consumed
 * identically by the raw-LLM path and the stored receipt strict read.
 *
 * Two entry shapes:
 *   raw model JSON    → requireSchema: true  (top-level `schema` key
 *                       required and must equal CEO_DECISION_SCHEMA)
 *   stored canonical  → requireSchema: false (`schema` is NOT stored in
 *                       the canonical proposal; a stored `schema` key
 *                       is an unknown field and fails)
 *
 * The proposal must contain EXACTLY the fields of its discriminated
 * variant — required fields present, every other variant's fields
 * absent, no unknown keys, no contradictory fields silently dropped.
 * Any forbidden decision kind rejects the WHOLE proposal.
 */
export function validateCanonicalCeoProposal(
  input: unknown,
  opts: { requireSchema?: boolean } = {},
): CeoProposal {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("proposal is not an object");
  }
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!TOP_LEVEL_KEYS.has(k)) invalid(`unknown top-level field ${k}`);
    if (!opts.requireSchema && k === "schema") {
      invalid("canonical proposal must not carry a schema field");
    }
  }
  if (opts.requireSchema && o.schema !== CEO_DECISION_SCHEMA) {
    invalid(`schema ${String(o.schema)} != ${CEO_DECISION_SCHEMA}`);
  }
  const kind = o.decision_kind;
  if (typeof kind !== "string") invalid("decision_kind required");
  if (CEO_FORBIDDEN_DECISION_KINDS.has(kind)) {
    forbidden(`decision_kind ${kind} is outside R1 authority`);
  }
  if (!Object.values(CEO_DECISION_KIND).includes(kind as CeoDecisionKind)) {
    invalid(`unknown decision_kind ${kind}`);
  }
  const summary = o.summary;
  if (summary !== undefined &&
      (typeof summary !== "string" || summary.length > CEO_MAX_SUMMARY_LEN)) {
    invalid("summary malformed or oversized");
  }

  const readWorkstreams = (): CeoProposalWorkstream[] => {
    if (!Array.isArray(o.workstreams) || o.workstreams.length === 0) {
      invalid("workstreams required");
    }
    return (o.workstreams as unknown[]).map((w, i) => {
      if (!w || typeof w !== "object" || Array.isArray(w)) {
        invalid(`workstreams[${i}] malformed`);
      }
      const we = w as Record<string, unknown>;
      for (const k of Object.keys(we)) {
        if (!WORKSTREAM_KEYS.has(k)) invalid(`workstreams[${i}] unknown field ${k}`);
      }
      for (const f of ["workstream_key", "title", "goal"] as const) {
        if (typeof we[f] !== "string" || !we[f]) {
          invalid(`workstreams[${i}].${f} required`);
        }
      }
      if (we.depends_on_keys !== undefined &&
          (!Array.isArray(we.depends_on_keys) ||
           we.depends_on_keys.some((d) => typeof d !== "string"))) {
        invalid(`workstreams[${i}].depends_on_keys malformed`);
      }
      return {
        workstream_key: we.workstream_key as string,
        title: we.title as string,
        goal: we.goal as string,
        ...(we.depends_on_keys !== undefined
          ? { depends_on_keys: we.depends_on_keys as string[] }
          : {}),
      };
    });
  };
  const readPriorityOrder = (): string[] => {
    if (!Array.isArray(o.priority_order) || o.priority_order.length === 0) {
      invalid("priority_order required");
    }
    if (o.priority_order.length > 64) invalid("priority_order oversized");
    return (o.priority_order as unknown[]).map((k) => {
      if (typeof k !== "string" || !k) invalid("priority_order entry malformed");
      return k;
    });
  };

  switch (kind as CeoDecisionKind) {
    case "INITIALIZE_WORKSTREAMS": {
      if (o.wait_reason !== undefined) {
        invalid("INITIALIZE_WORKSTREAMS must not carry wait_reason");
      }
      const workstreams = readWorkstreams();
      const priority_order = readPriorityOrder();
      // Priority order is exact-permutation provenance only in R1 — it
      // must cover exactly the proposed keys.
      const keys = new Set(workstreams.map((w) => w.workstream_key));
      if (priority_order.length !== keys.size ||
          new Set(priority_order).size !== keys.size ||
          !priority_order.every((k) => keys.has(k))) {
        invalid("priority_order is not an exact permutation of proposed workstreams");
      }
      return {
        decision_kind: "INITIALIZE_WORKSTREAMS",
        workstreams,
        priority_order,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "PRIORITIZE_EXISTING": {
      if (o.workstreams !== undefined) {
        invalid("PRIORITIZE_EXISTING must not submit workstreams");
      }
      if (o.wait_reason !== undefined) {
        invalid("PRIORITIZE_EXISTING must not carry wait_reason");
      }
      const priority_order = readPriorityOrder();
      return {
        decision_kind: "PRIORITIZE_EXISTING",
        priority_order,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "WAIT": {
      if (o.workstreams !== undefined) invalid("WAIT must not submit workstreams");
      if (o.priority_order !== undefined) invalid("WAIT must not submit priority_order");
      if (typeof o.wait_reason !== "string" || !CEO_WAIT_REASONS.has(o.wait_reason)) {
        invalid(`wait_reason ${String(o.wait_reason)} not allowlisted`);
      }
      return {
        decision_kind: "WAIT",
        wait_reason: o.wait_reason,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
  }
}

/**
 * THE ONE raw→canonical normalization boundary (R3.A). A strict
 * schema-constrained Codex output (`--output-schema`, OpenAI strict
 * mode: all properties required + nullable) emits explicit `null`
 * placeholders for variant-inapplicable fields, e.g. a WAIT decision
 * carries `workstreams: null, priority_order: null`.
 *
 * At THIS boundary ONLY: `null` on a variant-inapplicable field
 * normalizes to ABSENT. Non-null contradictory fields remain INVALID
 * inside the canonical validator. `depends_on_keys: null` inside a
 * workstream item normalizes the same way. The stored canonical
 * proposal therefore NEVER carries placeholder nulls —
 * assertCanonicalCeoDecision() keeps requiring the canonical shape.
 */
export function normalizeCeoRawProposalJson(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const o = { ...(input as Record<string, unknown>) };
  for (const k of ["workstreams", "priority_order", "wait_reason", "summary"]) {
    if (o[k] === null) delete o[k];
  }
  if (Array.isArray(o.workstreams)) {
    o.workstreams = o.workstreams.map((w) => {
      if (!w || typeof w !== "object" || Array.isArray(w)) return w;
      const we = { ...(w as Record<string, unknown>) };
      if (we.depends_on_keys === null) delete we.depends_on_keys;
      return we;
    });
  }
  return o;
}

/**
 * raw model text → JSON parse → null-placeholder normalization (R3.A)
 * → strict shape → discriminated-union validation. Any unknown field,
 * malformed member, forbidden kind, or contradictory authority-bearing
 * field rejects the WHOLE proposal.
 */
export function parseCeoDecisionText(raw: string): CeoProposal {
  if (typeof raw !== "string" || !raw.trim() || raw.length > CEO_MAX_OUTPUT_BYTES) {
    invalid("raw output empty or oversized");
  }
  let parsed: unknown;
  try {
    parsed = extractPlanJson(raw);
  } catch {
    invalid("no balanced JSON object in model output");
  }
  return validateCanonicalCeoProposal(
    normalizeCeoRawProposalJson(parsed),
    { requireSchema: true },
  );
}

/** Canonical digest of a validated proposal — decision receipt identity. */
export function ceoProposalDigest(p: CeoProposal): string {
  return digest({
    schema: CEO_DECISION_SCHEMA,
    decision_kind: p.decision_kind,
    workstreams: p.workstreams ?? null,
    priority_order: p.priority_order ?? null,
    wait_reason: p.wait_reason ?? null,
    summary: p.summary ?? null,
  });
}

/** Mandatory authority-boundary system prompt (P15.3 §5).
 *  R1 contract hardening (P15.7-fix1): the Codex CLI strict output
 *  schema requires ALL SIX top-level properties on every response, so
 *  the prompt must state per-kind null placement explicitly — a model
 *  mirroring a single flat template re-attaches populated `workstreams`
 *  to PRIORITIZE_EXISTING and the canonical validator must reject it. */
export function ceoDecisionSystemPrompt(): string {
  return `You are PAIR CEO_DECISION.

You are a proposal-only strategic decision model.

You receive a canonical Objective and current governed work state.

You may decide WHAT operational workstreams should exist or how current
workstreams should be prioritized.

You do NOT execute work.
You do NOT select agents or executors.
You do NOT choose Codex, Devin, DSH, Hermes or PAIR Native.
You do NOT create missions.
You do NOT mutate KPIs.
You do NOT change budget limits.
You do NOT alter Objective status.
You do NOT grant network access.
You do NOT send Telegram messages.
You do NOT invent evidence.

OUTPUT CONTRACT — schema ${CEO_DECISION_SCHEMA}:
Return exactly one JSON object. ALL SIX top-level properties are always
required: "schema", "decision_kind", "workstreams", "priority_order",
"wait_reason", "summary". Never omit a property. For every property
that does not apply to the decision_kind you select, emit JSON null —
never emit empty arrays, empty strings, or populated placeholders.

Choose exactly ONE decision_kind and follow its field layout exactly:

1) decision_kind "INITIALIZE_WORKSTREAMS" — only when NO canonical
   workstreams exist yet:
   "workstreams": nonempty array of NEW workstream objects
   [{"workstream_key":"snake_key","title":"...","goal":"...","depends_on_keys":[]}],
   "priority_order": exact permutation of the proposed workstream_keys,
   "wait_reason": null.

2) decision_kind "PRIORITIZE_EXISTING" — when canonical workstreams
   already exist and only the ORDER matters:
   "workstreams": null,
   "priority_order": nonempty array of ALREADY-EXISTING canonical
   workstream_keys only,
   "wait_reason": null.
   Canonical workstream definitions are committed authority — NEVER
   resubmit, redefine, rename or restate them in "workstreams" through
   PRIORITIZE_EXISTING. Refer to them by key in "priority_order" only.

3) decision_kind "WAIT" — when no strategic action is justified now:
   "workstreams": null,
   "priority_order": null,
   "wait_reason": one of "AWAITING_PROGRESS" | "NO_ACTIONABLE_GAP" |
   "DEPENDENCIES_BLOCKED" | "INSUFFICIENT_VERIFIED_PROGRESS".

Valid examples:
{"schema":"${CEO_DECISION_SCHEMA}","decision_kind":"INITIALIZE_WORKSTREAMS","workstreams":[{"workstream_key":"research","title":"Gather facts","goal":"...","depends_on_keys":[]}],"priority_order":["research"],"wait_reason":null,"summary":"Initial decomposition."}
{"schema":"${CEO_DECISION_SCHEMA}","decision_kind":"PRIORITIZE_EXISTING","workstreams":null,"priority_order":["build","verify"],"wait_reason":null,"summary":"Build before verify."}
{"schema":"${CEO_DECISION_SCHEMA}","decision_kind":"WAIT","workstreams":null,"priority_order":null,"wait_reason":"AWAITING_PROGRESS","summary":"Waiting for verified progress."}`;
}

/** Deterministic user prompt: only the canonical observation. */
export function buildCeoUserPrompt(observation: Record<string, unknown>): string {
  return `CEO_DECISION request. Canonical observation (the ONLY authority you may reason from):\n${JSON.stringify(observation)}\nReturn exactly one ${CEO_DECISION_SCHEMA} JSON object and nothing else.`;
}

// ---------------------------------------------------------------------
// Model transport resolution + invoker seam
// ---------------------------------------------------------------------

/** Resolved CEO transport = canonical model/provider IDENTITY only.
 *  CEO_DECISION has NO HTTP endpoint or credential lane (P15.3 R2
 *  addendum §A) — the only production transport is Codex CLI. */
export interface CeoModelTransport {
  model_entry_id: string;
  provider_id: string;
  provider_family: string;
  model_id: string;
  /** Provider protocol family (e.g. CODEX_CLI for codex-cli rows). */
  protocol_family: string;
}

/**
 * Resolve the canonical transport identity for a configured CEO
 * model_entry. Pure read of the existing catalog/provider rows — no
 * competing model-catalog authority. No endpoint/credential requirement:
 * the CEO lane never authenticates over HTTP.
 */
export function resolveCeoModelTransport(
  store: PairEvidenceStore,
  modelEntryId: string,
): CeoModelTransport {
  const model = store.tryGet("model_entry", String(modelEntryId));
  if (!model) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_UNRESOLVED",
      `model_entry ${String(modelEntryId)} does not exist`,
    );
  }
  const providerId = String(model.provider_id ?? "");
  const provider = providerId
    ? store.tryGet("provider", providerEntryId(providerId))
    : null;
  if (!provider) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_UNRESOLVED",
      `provider ${providerId} for model_entry ${String(modelEntryId)} does not exist`,
    );
  }
  // R3.B — Codex CLI is the ONLY CEO_DECISION provider authority: the
  // canonical transport identity itself must be Codex CLI. An eligible
  // model_entry under any other provider/protocol/endpoint is never
  // executed through `codex exec` — provenance mismatch fails closed.
  if (providerId !== CODEX_CLI_PROVIDER_ID) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT",
      `model_entry ${String(modelEntryId)} resolves to provider ${providerId}`,
    );
  }
  if (String(provider.protocol_family ?? "") !== CODEX_CLI_PROTOCOL_FAMILY) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT",
      `provider ${providerId} protocol_family ${String(provider.protocol_family)}`,
    );
  }
  const endpoint = String(
    provider.endpoint_reference ?? provider.configured_endpoint_identity ?? "");
  if (endpoint !== CODEX_CLI_ENDPOINT) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT",
      `provider ${providerId} endpoint identity mismatch`,
    );
  }
  return {
    model_entry_id: String(model.model_entry_id),
    provider_id: providerId,
    provider_family: String(model.provider_family ?? providerId),
    model_id: String(model.model_id),
    protocol_family: String(provider.protocol_family ?? ""),
  };
}

export interface CeoInvokeInput {
  transport: CeoModelTransport;
  system_prompt: string;
  user_prompt: string;
  observation_digest: string;
  timeout_ms?: number;
}

export interface CeoInvokeResult {
  model_entry_id: string;
  provider_id: string;
  model_id: string;
  raw_text: string;
}

/** The injectable seam — the controller owns parsing and authority. */
export interface CeoDecisionInvoker {
  invoke(input: CeoInvokeInput): Promise<CeoInvokeResult>;
}

// ---------------------------------------------------------------------
// Codex CLI CEO invoker — the ONLY production CEO_DECISION transport
// (P15.3 R2 addendum §B). Reasoning rides the persisted Codex CLI /
// ChatGPT subscription session (`codex exec -m <model>`). There is NO
// API fallback: OPENAI_API_KEY/CODEX_API_KEY are stripped from the child
// environment by the shared transport; CLI missing / logged out / rate
// limited / model unavailable / timeout / malformed output all fail
// closed with typed codes.
// ---------------------------------------------------------------------

/** Strict schema-constrained output for `codex exec --output-schema`.
 *  OpenAI strict structured output requires `additionalProperties:false`
 *  and all properties in `required` — variant-conditional fields are
 *  therefore required-but-nullable; the canonical contract parse
 *  (validateCanonicalCeoProposal) remains the authority on variant
 *  discipline. */
export const CEO_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "decision_kind", "workstreams", "priority_order", "wait_reason", "summary"],
  properties: {
    schema: { type: "string", enum: [CEO_DECISION_SCHEMA] },
    decision_kind: {
      type: "string",
      enum: [
        CEO_DECISION_KIND.INITIALIZE_WORKSTREAMS,
        CEO_DECISION_KIND.PRIORITIZE_EXISTING,
        CEO_DECISION_KIND.WAIT,
      ],
    },
    workstreams: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["workstream_key", "title", "goal", "depends_on_keys"],
        properties: {
          workstream_key: { type: "string" },
          title: { type: "string" },
          goal: { type: "string" },
          depends_on_keys: { type: ["array", "null"], items: { type: "string" } },
        },
      },
    },
    priority_order: { type: ["array", "null"], items: { type: "string" } },
    wait_reason: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
  },
};

/** CEO argv — same hard isolation profile as the Planner transport
 *  (--ephemeral, --ignore-user-config/--ignore-rules/--strict-config,
 *  approval_policy=never, web_search disabled, network off, read-only
 *  workspace bounded to the scratch run dir) under a distinct
 *  `pair_ceo` permission profile. The Codex process is a model transport
 *  only — no governed-executor flags, no workspace mutation authority. */
export function ceoCliArgv(
  model: string,
  runDir: string,
  schemaPath: string,
  finalPath: string,
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--color", "never",
    "--config", "approval_policy=never",
    "--config", "web_search=disabled",
    "--config", "default_permissions=pair_ceo",
    "--config", "permissions.pair_ceo.extends=:workspace",
    "--config", `permissions.pair_ceo.filesystem={':minimal'='read','${runDir}'='read'}`,
    "--config", "permissions.pair_ceo.network.enabled=false",
    "--config", `permissions.pair_ceo.workspace_roots={'${runDir}'=true}`,
    "-m", model,
    "-C", runDir,
    "--output-schema", schemaPath,
    "--output-last-message", finalPath,
    "--json",
  ];
}

/**
 * The production CEO invoker: `codex exec` under the `pair_ceo`
 * read-only profile. Reuses the ONE generic auth-safe transport
 * (codex-cli-transport.ts) — never codexPlannerPlan() (that is the
 * Planner contract). Output stays UNTRUSTED: schema-constrained or not,
 * it still flows through parseCeoDecisionText → the deterministic gate.
 * Never persists raw output; the caller pins only response_digest.
 */
export class CodexCliCeoDecisionInvoker implements CeoDecisionInvoker {
  constructor(
    private readonly opts: {
      env?: CodexCliEnv;
      /** Absolute codex executable (default: PAIR_CODEX_EXECUTABLE /
       *  PAIR_CODEX_PLANNER_EXECUTABLE / `which codex`). */
      executable?: string;
      /** Scratch root for per-invocation run dirs. */
      scratchDir?: string;
    } = {},
  ) {}

  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    // R3.B — defensive authority: this invoker executes `codex exec`;
    // a transport claiming any other provider/protocol is refused
    // BEFORE spawn (forged transports never reach the CLI).
    if (input.transport.provider_id !== CODEX_CLI_PROVIDER_ID ||
        input.transport.protocol_family !== CODEX_CLI_PROTOCOL_FAMILY) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT",
        `transport ${input.transport.provider_id}/${input.transport.protocol_family} is not codex-cli`,
      );
    }
    const exe = this.opts.executable ?? resolveCodexExecutable(this.opts.env);
    if (!exe) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_CLI_MISSING",
        "codex executable not resolvable",
      );
    }
    const scratchDir =
      this.opts.scratchDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pair-ceo-"));
    const prompt = `${input.system_prompt}\n\n${input.user_prompt}`;
    let out: Awaited<ReturnType<typeof invokeCodexCli>>;
    try {
      out = await invokeCodexCli(
        {
          executable: exe,
          model: input.transport.model_id,
          timeoutMs: input.timeout_ms ?? CEO_DEFAULT_TIMEOUT_MS,
          scratchDir,
          schema: CEO_DECISION_JSON_SCHEMA,
          runPrefix: "ceo",
          // R3.C — bound BEFORE read: an oversized final file is
          // rejected from its stat() size, never buffered.
          maxFinalBytes: CEO_MAX_OUTPUT_BYTES,
          // R3.C — raw model output is never durable evidence: the
          // per-invocation run dir is removed on every outcome.
          removeRunDir: true,
          argv: (runDir, schemaPath, finalPath) =>
            ceoCliArgv(input.transport.model_id, runDir, schemaPath, finalPath),
        },
        prompt,
        this.opts.env,
      );
    } catch (e) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_CLI_UNAVAILABLE",
        `spawn error ${String(e).slice(0, 120)}`,
      );
    }
    const { result, finalText, finalOversized } = out;
    if (finalOversized) {
      throw new IntegrityError("FAIL_CLOSED_CEO_CLI_OUTPUT_INVALID", "output oversized");
    }
    if (result.status === "TIMEOUT") {
      throw new IntegrityError("FAIL_CLOSED_CEO_CLI_TIMEOUT", result.error ?? "codex timeout");
    }
    if (result.status === "SPAWN_FAILED") {
      const missing = /ENOENT|not found/i.test(result.error ?? "");
      throw new IntegrityError(
        missing ? "FAIL_CLOSED_CEO_CLI_MISSING" : "FAIL_CLOSED_CEO_CLI_UNAVAILABLE",
        (result.error ?? "spawn failed").slice(0, 160),
      );
    }
    if (result.status === "FAILED") {
      const warn = classifyCodexCliExit(result.code, result.stderrTail);
      const code =
        warn === CODEX_CLI_WARNING.AUTH_FAILED ? "FAIL_CLOSED_CEO_CLI_AUTH_FAILED"
        : warn === CODEX_CLI_WARNING.MODEL_UNAVAILABLE ? "FAIL_CLOSED_CEO_CLI_MODEL_UNAVAILABLE"
        : warn === CODEX_CLI_WARNING.RATE_LIMITED ? "FAIL_CLOSED_CEO_CLI_RATE_LIMITED"
        : "FAIL_CLOSED_CEO_CLI_UNAVAILABLE";
      throw new IntegrityError(code, `${warn}:${(result.stderrTail || "").slice(0, 120)}`);
    }
    if (!finalText || !finalText.trim()) {
      throw new IntegrityError("FAIL_CLOSED_CEO_CLI_OUTPUT_INVALID", "empty final message");
    }
    if (Buffer.byteLength(finalText, "utf8") > CEO_MAX_OUTPUT_BYTES) {
      throw new IntegrityError("FAIL_CLOSED_CEO_CLI_OUTPUT_INVALID", "output oversized");
    }
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: finalText,
    };
  }
}
