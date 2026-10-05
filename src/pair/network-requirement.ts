/**
 * network-requirement.ts — canonical STRUCTURED network/source requirement
 * (post-incident remediation R1).
 *
 * Root cause closed: NETWORK authority used to depend on raw-goal vocabulary
 * (`goalRequiresCurrentExternalData` regexes) — a Vietnamese goal asking for
 * current external data but mentioning "file"/"outbox" was suppressed by
 * LOCAL_SOURCE as a local-state request while the task-side gate still saw
 * the task as network-required → repair dead code → plan died.
 *
 * Architecture (mandate):
 *   natural-language goal → PLANNER normalizes semantics → canonical
 *   structured `network_requirement` on each task → deterministic
 *   capability derivation → existing NETWORK gates → executor.
 *
 * The planner only UNDERSTANDS and NORMALIZES meaning (multilingual by
 * construction — the policy layer never parses goal/task language). PAIR's
 * deterministic code alone decides NETWORK authority. A task declaring
 * `EXTERNAL_*` + READ/RESEARCH/FETCH derives a NETWORK_ACCESS requirement;
 * LOCAL/UNKNOWN can never be elevated by declaration alone.
 *
 * Normalization (sanitizePlan, shared by every transport):
 *   top-level `network_requirement` is authoritative; a legacy
 *   `metadata.network_requirement` is honored only when top-level is absent
 *   — both present and different is a deterministic conflict (task dropped).
 *   Shape-invalid fields are dropped to legacy detection (garbage can never
 *   act as evidence); they can therefore never elevate anything.
 *
 * Authority (serve canonicalizer): a shape-valid but contradictory field —
 *   internal (LOCAL/UNKNOWN carrying an external-shaped locator, or any
 *   locator under NONE intent), or contradicting the task's own instruction —
 *   rejects the CANDIDATE via `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID`
 *   (typed, REASK-eligible). We never silently pick a side.
 *
 * Precedence: a task carrying valid structured evidence is judged by it;
 * tasks without the field keep the legacy instruction/goal vocabulary
 * detectors. The plan-level legacy goal check fires ONLY when no task
 * declares a derived-required structured requirement — declared structured
 * evidence is never vetoed by raw-goal wording.
 */

export const NETWORK_SOURCE_KINDS = [
  "LOCAL",
  "EXTERNAL_SITE",
  "EXTERNAL_API",
  "REMOTE_REPOSITORY",
  "UNKNOWN",
] as const;
export type NetworkSourceKind = (typeof NETWORK_SOURCE_KINDS)[number];

export const NETWORK_ACCESS_INTENTS = [
  "NONE",
  "READ",
  "RESEARCH",
  "FETCH",
] as const;
export type NetworkAccessIntent = (typeof NETWORK_ACCESS_INTENTS)[number];

export const NETWORK_FRESHNESSES = [
  "NOT_REQUIRED",
  "REQUIRED",
  "UNKNOWN",
] as const;
export type NetworkFreshness = (typeof NETWORK_FRESHNESSES)[number];

export interface NetworkRequirement {
  source_kind: NetworkSourceKind;
  access_intent: NetworkAccessIntent;
  freshness: NetworkFreshness;
  source_locator?: string;
}

/** Typed canonical rejection for a present-but-invalid or contradictory
 *  structured requirement — in the FAIL_CLOSED_PLAN_* family so the pool's
 *  REASK eligibility prefix already covers it. */
export const FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID =
  "FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID";

/** Bounded safe grammar for a declared source locator — a hostname, URL,
 *  or path-like identifier. No whitespace/quotes; printable only. */
const LOCATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@%+=&,-]{0,159}$/;

/** A locator unambiguously shaped like an EXTERNAL source: a scheme URL, a
 *  www. host, or a dotted hostname on a well-known public TLD. A bare file
 *  name (config.yaml) or repo path never matches — LOCAL tasks may carry
 *  local locators freely. */
const EXTERNAL_LOCATOR_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|\.(?:com|net|org|io|dev|ai|app|co|edu|gov|mil|info|biz|me|gg|tv|xyz|site|market|cloud|tech|gg)(?:[/:?#]|$)/i;

const isEnum = <T extends readonly string[]>(
  v: unknown,
  list: T,
): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

export const isExternalShapedLocator = (s: string): boolean =>
  EXTERNAL_LOCATOR_RE.test(s);

export type NetworkRequirementShapeResult =
  | { ok: true; req: NetworkRequirement }
  | { ok: false; reason: "NOT_OBJECT" | "BAD_FIELD" | "BAD_LOCATOR" };

/** Structural validation only — enum membership, locator grammar. Returns a
 *  CANONICAL normalized object (fields re-ordered, locator trimmed) so a
 *  re-normalization round-trip is byte-identical. Shape-invalid input can
 *  never act as structured evidence (caller drops it). */
export function parseNetworkRequirementShape(
  v: unknown,
): NetworkRequirementShapeResult {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, reason: "NOT_OBJECT" };
  }
  const o = v as Record<string, unknown>;
  if (!isEnum(o.source_kind, NETWORK_SOURCE_KINDS)) {
    return { ok: false, reason: "BAD_FIELD" };
  }
  if (!isEnum(o.access_intent, NETWORK_ACCESS_INTENTS)) {
    return { ok: false, reason: "BAD_FIELD" };
  }
  if (!isEnum(o.freshness, NETWORK_FRESHNESSES)) {
    return { ok: false, reason: "BAD_FIELD" };
  }
  const req: NetworkRequirement = {
    source_kind: o.source_kind,
    access_intent: o.access_intent,
    freshness: o.freshness,
  };
  if (o.source_locator !== undefined && o.source_locator !== null) {
    if (typeof o.source_locator !== "string") {
      return { ok: false, reason: "BAD_LOCATOR" };
    }
    const loc = o.source_locator.trim();
    if (!loc || !LOCATOR_RE.test(loc)) {
      return { ok: false, reason: "BAD_LOCATOR" };
    }
    req.source_locator = loc;
  }
  return { ok: true, req };
}

/** Deterministic capability derivation — the ONLY authority deciding
 *  NETWORK requirement from structured evidence:
 *    EXTERNAL_SITE / EXTERNAL_API / REMOTE_REPOSITORY + READ/RESEARCH/FETCH
 *      → NETWORK_ACCESS required.
 *    LOCAL — never required.
 *    UNKNOWN / access_intent NONE — cannot be elevated by declaration. */
export function networkRequirementRequiresAccess(req: NetworkRequirement): boolean {
  return (
    (req.source_kind === "EXTERNAL_SITE" ||
      req.source_kind === "EXTERNAL_API" ||
      req.source_kind === "REMOTE_REPOSITORY") &&
    (req.access_intent === "READ" ||
      req.access_intent === "RESEARCH" ||
      req.access_intent === "FETCH")
  );
}

/** A shape-valid requirement that is internally self-contradictory — the
 *  mandate's `source_kind=LOCAL + source_locator=https://mql5.com` class.
 *  The caller rejects the candidate; we never silently pick a side. */
export function networkRequirementInternalContradiction(
  req: NetworkRequirement,
): "LOCAL_WITH_EXTERNAL_LOCATOR" | "LOCATOR_WITHOUT_SOURCE" | null {
  const loc = req.source_locator;
  if (loc === undefined) return null;
  if (req.source_kind === "LOCAL" && isExternalShapedLocator(loc)) {
    return "LOCAL_WITH_EXTERNAL_LOCATOR";
  }
  if (req.source_kind === "UNKNOWN") {
    // A locator asserts source knowledge UNKNOWN explicitly lacks.
    return "LOCATOR_WITHOUT_SOURCE";
  }
  if (req.access_intent === "NONE") {
    // A declared locator with no access intent is incoherent evidence.
    return "LOCATOR_WITHOUT_SOURCE";
  }
  return null;
}

/** Unified per-task authority verdict — shared by the repair seam and the
 *  canonical gate so both derive the SAME answer from the SAME evidence. */
export type NetworkTaskAuthority =
  | {
      present: true;
      required: boolean;
      consistent: true;
      req: NetworkRequirement;
      contradiction: null;
    }
  | {
      present: boolean;
      required: boolean;
      consistent: false;
      contradiction: "LOCAL_WITH_EXTERNAL_LOCATOR" | "LOCATOR_WITHOUT_SOURCE";
      req: NetworkRequirement | null;
    }
  | { present: false; required: false; consistent: true; contradiction: null; req: null };

/** Evaluate a task's normalized `metadata.network_requirement` against its
 *  instruction. `instructionIsNetworkShaped` is the caller's legacy
 *  task-side detector — kept as a parameter so this module never imports
 *  the vocabulary layer (the policy layer derives from structure). */
export function taskNetworkAuthority(args: {
  req: NetworkRequirement | null;
  instruction: string;
  instructionIsNetworkShaped: boolean;
}): NetworkTaskAuthority {
  const { req, instruction, instructionIsNetworkShaped } = args;
  if (!req) {
    return {
      present: false,
      required: false,
      consistent: true,
      contradiction: null,
      req: null,
    };
  }
  const internal = networkRequirementInternalContradiction(req);
  if (internal) {
    return {
      present: true,
      required: false,
      consistent: false,
      contradiction: internal,
      req,
    };
  }
  const required = networkRequirementRequiresAccess(req);
  if (required) {
    // The structured declaration IS the semantic normalization — the
    // planner classified an external source; deterministic derivation
    // grants from it. Requiring fetch vocabulary in the instruction too
    // would rebuild the brittleness this field replaces (a valid
    // "research the MQL5 site" phrasing is not a contradiction).
    return {
      present: true,
      required: true,
      consistent: true,
      contradiction: null,
      req,
    };
  }
  // Not-required declarations are trusted verbatim. An instruction-
  // vocabulary cross-check was tried and removed: downstream tasks echo
  // the goal's recency/research phrasing ("summarize the trending EA
  // data") which the legacy detector flags as fetch-shaped, rejecting
  // every correct LOCAL declaration the planner emits. A mis-declared
  // LOCAL/UNKNOWN task simply lacks NETWORK_ACCESS — it fails visibly
  // downstream, never gains authority it didn't prove.
  return {
    present: true,
    required: false,
    consistent: true,
    contradiction: null,
    req,
  };
}
