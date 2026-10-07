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
export const CEO_DEFAULT_TIMEOUT_MS = 20000;

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
 * raw model text → JSON parse → strict shape → discriminated-union
 * validation. Any unknown field, malformed member, forbidden kind, or
 * contradictory authority-bearing field rejects the WHOLE proposal.
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalid("output is not an object");
  }
  const o = parsed as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!TOP_LEVEL_KEYS.has(k)) invalid(`unknown top-level field ${k}`);
  }
  if (o.schema !== CEO_DECISION_SCHEMA) {
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
        if (typeof we[f] !== "string") invalid(`workstreams[${i}].${f} required`);
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

/** Mandatory authority-boundary system prompt (P15.3 §5). */
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

Return only the required JSON decision contract:
{"schema":"${CEO_DECISION_SCHEMA}","decision_kind":"INITIALIZE_WORKSTREAMS"|"PRIORITIZE_EXISTING"|"WAIT","workstreams":[{"workstream_key":"...","title":"...","goal":"...","depends_on_keys":["..."]}],"priority_order":["..."],"wait_reason":"AWAITING_PROGRESS"|"NO_ACTIONABLE_GAP"|"DEPENDENCIES_BLOCKED"|"INSUFFICIENT_VERIFIED_PROGRESS","summary":"..."}`;
}

/** Deterministic user prompt: only the canonical observation. */
export function buildCeoUserPrompt(observation: Record<string, unknown>): string {
  return `CEO_DECISION request. Canonical observation (the ONLY authority you may reason from):\n${JSON.stringify(observation)}\nReturn exactly one ${CEO_DECISION_SCHEMA} JSON object and nothing else.`;
}

// ---------------------------------------------------------------------
// Model transport resolution + invoker seam
// ---------------------------------------------------------------------

export interface CeoModelTransport {
  model_entry_id: string;
  provider_id: string;
  provider_family: string;
  model_id: string;
  /** Provider chat/completions base (no /chat/completions suffix). */
  endpoint: string;
  /** Env var NAME holding the credential — never the value. */
  credential_env: string;
}

/**
 * Resolve the canonical transport for a configured CEO model_entry.
 * Pure read of the existing catalog/provider rows — no competing
 * model-catalog authority.
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
  const endpoint =
    String(provider.configured_endpoint_identity ?? "") ||
    String(provider.endpoint_reference ?? "");
  const envs = (provider.credential_envs as string[] | undefined) ?? [];
  const credentialEnv =
    String(provider.credential_reference_name ?? "") || String(envs[0] ?? "");
  if (!endpoint || !credentialEnv) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_UNRESOLVED",
      `provider ${providerId} lacks endpoint/credential reference`,
    );
  }
  return {
    model_entry_id: String(model.model_entry_id),
    provider_id: providerId,
    provider_family: String(model.provider_family ?? providerId),
    model_id: String(model.model_id),
    endpoint,
    credential_env: credentialEnv,
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

/**
 * OpenAI-compatible chat/completions implementation. Reuses only generic
 * low-level mechanics (fetch injection, env credential lookup, bounded
 * timeout) — never llmPlan, never Planner prompts/contracts.
 */
export class OpenAiCeoDecisionInvoker implements CeoDecisionInvoker {
  constructor(
    private readonly opts: {
      env?: NodeJS.ProcessEnv | ((name: string) => string | undefined);
      fetchFn?: typeof fetch;
    } = {},
  ) {}

  private envGet(name: string): string | undefined {
    const env = this.opts.env;
    if (!env) return process.env[name];
    return typeof env === "function" ? env(name) : env[name];
  }

  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    const apiKey = this.envGet(input.transport.credential_env);
    if (!apiKey) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_INVOCATION",
        `credential env ${input.transport.credential_env} not resolvable`,
      );
    }
    const fetchImpl = this.opts.fetchFn ?? fetch;
    const resp = await fetchImpl(`${input.transport.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.transport.model_id,
        messages: [
          { role: "system", content: input.system_prompt },
          { role: "user", content: input.user_prompt },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(input.timeout_ms ?? CEO_DEFAULT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_INVOCATION",
        `provider HTTP ${resp.status}`,
      );
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = String(data.choices?.[0]?.message?.content ?? "");
    if (text.length > CEO_MAX_OUTPUT_BYTES) {
      throw new IntegrityError("FAIL_CLOSED_CEO_INVOCATION", "output oversized");
    }
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: text,
    };
  }
}
