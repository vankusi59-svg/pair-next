/**
 * network-requirement.ts — canonical STRUCTURED network/source requirement
 * (post-incident remediation R1 + audit remediation R2).
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
 *   requirement derivation → OPERATOR-side authorization check → governed
 *   capability binding → existing NETWORK gates → executor.
 *
 * R2 closes two authority blockers:
 *
 *  BLOCKER 1 — a planner declaration must never bootstrap capability.
 *    A structured requirement is SEMANTIC evidence ("task needs network"),
 *    not a capability grant. NETWORK_ACCESS may only bind when the
 *    OPERATOR GOAL itself authorizes external access for the declared
 *    source: the requirement's `source_locator` host must be a host the
 *    goal text literally names (syntactic URL/hostname extraction — no
 *    TLD vocabulary, no planner-prose trust). EXTERNAL + locator the
 *    goal never authorized → typed INVALID (UNAUTHORIZED_SOURCE), never
 *    a silent pick, never elevation. LOCAL/UNKNOWN + a NETWORK_ACCESS
 *    claim → INVALID (UNAUTHORIZED_CAPABILITY).
 *
 *  BLOCKER 2 — fresh vs legacy provenance is explicit CONTEXT, never a
 *    guess. Every planner-transport emission canonicalizes under the
 *    fresh contract: each work task MUST carry a valid structured field;
 *    missing/malformed/conflict is a typed candidate rejection
 *    (REQUIREMENT_MISSING / REQUIREMENT_MALFORMED / REQUIREMENT_CONFLICT)
 *    that re-asks/fails over — it NEVER falls back to vocabulary
 *    detectors. Only the persisted-plan path (`metadata.llm_plan` on a
 *    stored mission — tasks already canonicalized before the field was
 *    mandatory) may keep the legacy instruction/goal detectors, and only
 *    tasks that provably lack the field.
 *
 * Planner field contract (sanitizePlan, shared by every transport):
 *   top-level `network_requirement` is authoritative; a legacy
 *   `metadata.network_requirement` is honored only when top-level is
 *   absent — both present and different marks `CONFLICT` (candidate
 *   rejects typed, never silently resolved). Shape-invalid input marks
 *   `MALFORMED` — it can never act as evidence.
 *
 * Locator handling (audit item): NO enumerated TLD list. A locator is
 *   "external-shaped" iff it carries a scheme (`https?://…`), a `www.`
 *   prefix, or resolves to a host the operator goal itself names. A bare
 *   file name or path never classifies as external.
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

/** Typed canonical rejection for an invalid/contradictory/unauthorized
 *  structured requirement — in the FAIL_CLOSED_PLAN_* family so the
 *  pool's REASK eligibility prefix already covers it. */
export const FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID =
  "FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID";

/** Reserved PAIR marker sanitize writes when a present field fails
 *  shape/conflict validation — how the canonical gate distinguishes
 *  "malformed emission" (typed reject) from "field absent". */
export const NETWORK_REQUIREMENT_ERROR_KEY = "network_requirement_error";

/** Bounded safe grammar for a declared source locator — a hostname, URL,
 *  or path-like identifier. No whitespace/quotes; printable only. */
const LOCATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@%+=&,-]{0,159}$/;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_SHAPE_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

const stripWww = (h: string): string => h.replace(/^www\./i, "");

/** Extract the hostname a locator resolves to — TLD-free syntactic
 *  classification: `scheme://host[/…]`, `www.host[…]`, or a bare
 *  dotted-host first segment (`mql5.com/en/market` → `mql5.com`).
 *  Anything else (file names, paths, single labels) → null. */
export function requirementLocatorHost(locator: string | undefined | null): string | null {
  if (!locator) return null;
  const s = String(locator).trim();
  if (!s) return null;
  const noScheme = s.replace(SCHEME_RE, "");
  const firstSeg = noScheme.split(/[/?#]/, 1)[0] ?? "";
  if (!HOST_SHAPE_RE.test(firstSeg)) return null;
  return stripWww(firstSeg.toLowerCase());
}

/** Unambiguously-external evidence: the locator itself carries external
 *  shape — an explicit `scheme://` or a `www.` prefix. A bare dotted
 *  token (`mql5.com`, `report.txt`) is AMBIGUOUS — it can equally be a
 *  hostname or a file name — so it never counts as contradiction
 *  evidence on its own. */
export function isUnambiguousExternalLocator(locator: string): boolean {
  const s = String(locator ?? "").trim();
  return SCHEME_RE.test(s) || /^www\./i.test(s);
}

/** Syntactic external-source shape: a scheme URL, a www. host, or a bare
 *  host the goal itself names. Replaces the former hard-coded public TLD
 *  list — a bare `report.txt`/`config.yaml` token is NOT external even
 *  though it carries a dot, unless the goal literally names it as a host. */
export function isExternalShapedLocator(
  locator: string,
  goalHosts?: ReadonlySet<string>,
): boolean {
  const s = String(locator ?? "").trim();
  if (isUnambiguousExternalLocator(s)) return true;
  const h = requirementLocatorHost(s);
  return h !== null && goalHosts !== undefined && goalHosts.has(h);
}

/** Syntactic host extraction from the operator goal — the canonical
 *  operator-side authorization surface. Both URL forms and bare dotted
 *  hostnames qualify (hostname charset + ≥1 dot, `www.` normalized to the
 *  bare host). NO TLD vocabulary: whatever the operator literally wrote
 *  as a host-shaped token is what they authorized. */
export function extractGoalHosts(goal: string): Set<string> {
  const hosts = new Set<string>();
  const g = String(goal ?? "");
  for (const m of g.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi)) {
    try {
      const h = new URL(m[0]).hostname.toLowerCase();
      if (h) hosts.add(stripWww(h));
    } catch {
      const seg = requirementLocatorHost(m[0]);
      if (seg) hosts.add(seg);
    }
  }
  for (const m of g.matchAll(/(?<![\w/.-])[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?![\w/.-])/g)) {
    hosts.add(stripWww(m[0].toLowerCase()));
  }
  return hosts;
}

/** Identity tokens — a proper-noun-shaped word the goal names (contains
 *  a digit or an uppercase letter, so common lowercase nouns like
 *  "price"/"models" never qualify): "MQL5", "GPT", "OpenAI", "Stripe",
 *  "MT5". When the operator names an external entity, the planner's
 *  normalization of that entity into a host ("mql5.com") stays
 *  operator-authorized; a locator for a different entity never is. */
export function extractGoalIdentities(goal: string): Set<string> {
  const ids = extractGoalHosts(goal);
  for (const m of String(goal ?? "").matchAll(
    /(?<![\w/.-])[a-zA-Z0-9][a-zA-Z0-9-]{1,31}(?![\w/.-])/g,
  )) {
    const tok = m[0];
    // Proper-noun shape: a digit, an uppercase letter past position 0
    // (camelCase brand "OpenAI"), or ≥2 ALL-CAPS letters ("GPT", "EA").
    // Plain lowercase nouns and sentence-initial capitals never qualify.
    const letters = (tok.match(/[a-zA-Z]/g) ?? []).length;
    const allCaps = letters >= 2 && letters === (tok.match(/[A-Z]/g) ?? []).length;
    if (/[0-9]/.test(tok) || /[A-Z]/.test(tok.slice(1)) || allCaps) {
      ids.add(tok.toLowerCase());
    }
  }
  return ids;
}

/** Does the operator goal authorize external access to this host?
 *  Syntactic bindings, nothing else: exact host match, parent-domain
 *  containment either direction (goal names `mql5.com`, locator is
 *  `api.mql5.com` — or vice versa), or a host label equal to a
 *  goal-named IDENTITY token (goal says "MQL5" → `mql5.com` stays
 *  authorized; a locator for a different entity never is).
 *  No host/identity in the goal → nothing external is authorized. */
export function goalAuthorizesHost(
  host: string,
  goalIdentities: ReadonlySet<string>,
): boolean {
  const labels = host.split(".");
  for (const g of goalIdentities) {
    if (
      host === g ||
      host.endsWith(`.${g}`) ||
      g.endsWith(`.${host}`) ||
      labels.includes(g)
    ) {
      return true;
    }
  }
  return false;
}

const isEnum = <T extends readonly string[]>(
  v: unknown,
  list: T,
): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

export type NetworkRequirementShapeResult =
  | { ok: true; req: NetworkRequirement }
  | { ok: false; reason: "NOT_OBJECT" | "BAD_FIELD" | "BAD_LOCATOR" };

/** Structural validation only — enum membership, locator grammar. Returns a
 *  CANONICAL normalized object (fields re-ordered, locator trimmed) so a
 *  re-normalization round-trip is byte-identical. Shape-invalid input can
 *  never act as structured evidence. */
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

/** Deterministic SEMANTIC requirement derivation — "this task needs
 *  network", not "the operator authorized it":
 *    EXTERNAL_SITE / EXTERNAL_API / REMOTE_REPOSITORY + READ/RESEARCH/FETCH
 *      → semantically required.
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

/** OPERATOR-side authorization (BLOCKER 1): the requirement's declared
 *  locator must resolve to a host the operator goal itself names.
 *  source_locator / planner prose alone is never authorization. */
export function networkRequirementOperatorAuthorized(
  req: NetworkRequirement,
  goalHosts: ReadonlySet<string>,
): boolean {
  if (!networkRequirementRequiresAccess(req)) return false;
  const host = requirementLocatorHost(req.source_locator);
  if (!host) return false;
  return goalAuthorizesHost(host, goalHosts);
}

/** A shape-valid requirement that is internally self-contradictory — the
 *  mandate's `source_kind=LOCAL + source_locator=https://mql5.com` class.
 *  The caller rejects the candidate; we never silently pick a side. */
export function networkRequirementInternalContradiction(
  req: NetworkRequirement,
): "LOCAL_WITH_EXTERNAL_LOCATOR" | "LOCATOR_WITHOUT_SOURCE" | null {
  const loc = req.source_locator;
  if (loc === undefined) return null;
  if (req.source_kind === "LOCAL" && isUnambiguousExternalLocator(loc)) {
    // `LOCAL + locator=https://mql5.com` — the mandate's forged example:
    // unambiguous external evidence contradicting a LOCAL declaration.
    // (A bare dotted token like `report.txt` is ambiguous and cannot
    // contradict — such a task degrades to NOT_REQUIRED and can never
    // elevate, which is the fail-closed direction.)
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

/** What sanitize left on the task — distinguishes "field absent" from
 *  "field present but unusable". */
export type NetworkRequirementFieldState =
  | "valid"
  | "missing"
  | "malformed"
  | "conflict";

export function networkRequirementFieldState(
  task: Record<string, unknown>,
): NetworkRequirementFieldState {
  const md = task.metadata as Record<string, unknown> | undefined;
  const err = md?.[NETWORK_REQUIREMENT_ERROR_KEY];
  if (err === "CONFLICT") return "conflict";
  if (err !== undefined) return "malformed";
  return md?.network_requirement !== undefined ? "valid" : "missing";
}

/** The ONE canonical authority verdict — consumed identically by the
 *  repair seam and the canonical gate ("Both must consume the same
 *  canonical authority verdict/helper").
 *
 *  INVALID  — the candidate is rejected typed (REASK/failover):
 *             malformed/conflict evidence, missing field under the fresh
 *             contract, internally contradictory, or semantically
 *             required without operator authorization.
 *  REQUIRED — semantically required AND operator-authorized: NETWORK
 *             capability may bind (repair adds it when servable; the gate
 *             still rejects when a repair was impossible).
 *  NOT_REQUIRED — structured field says no network; vocabulary may never
 *             override it and a NETWORK_ACCESS claim is unauthorized.
 *  LEGACY   — no structured evidence on a persisted pre-contract plan;
 *             the caller may run the legacy vocabulary detectors (fresh
 *             plans never reach this verdict). */
export type NetworkTaskResolution =
  | {
      verdict: "REQUIRED" | "NOT_REQUIRED" | "LEGACY";
      authorized: boolean;
      reason: null;
      req: NetworkRequirement | null;
    }
  | {
      verdict: "INVALID";
      authorized: false;
      reason:
        | "REQUIREMENT_MISSING"
        | "REQUIREMENT_MALFORMED"
        | "REQUIREMENT_CONFLICT"
        | "LOCAL_WITH_EXTERNAL_LOCATOR"
        | "LOCATOR_WITHOUT_SOURCE"
        | "UNAUTHORIZED_SOURCE";
      req: NetworkRequirement | null;
    };

export function resolveTaskNetworkAuthority(args: {
  req: NetworkRequirement | null;
  state: NetworkRequirementFieldState;
  goalIdentities: ReadonlySet<string>;
  /** true = fresh planner emission (structured contract mandatory);
   *  false = persisted plan provenance (legacy fallback allowed). */
  fresh: boolean;
}): NetworkTaskResolution {
  const { req, state, goalIdentities, fresh } = args;
  if (state === "malformed" || state === "conflict") {
    return {
      verdict: "INVALID",
      authorized: false,
      reason: state === "conflict" ? "REQUIREMENT_CONFLICT" : "REQUIREMENT_MALFORMED",
      req,
    };
  }
  if (req === null) {
    if (fresh) {
      return {
        verdict: "INVALID",
        authorized: false,
        reason: "REQUIREMENT_MISSING",
        req: null,
      };
    }
    return { verdict: "LEGACY", authorized: false, reason: null, req: null };
  }
  const internal = networkRequirementInternalContradiction(req);
  if (internal) {
    return {
      verdict: "INVALID",
      authorized: false,
      reason: internal,
      req,
    };
  }
  const required = networkRequirementRequiresAccess(req);
  if (!required) {
    return { verdict: "NOT_REQUIRED", authorized: false, reason: null, req };
  }
  if (!networkRequirementOperatorAuthorized(req, goalIdentities)) {
    // Semantically required but the operator goal never authorized the
    // declared source — a planner declaration is never authorization.
    return {
      verdict: "INVALID",
      authorized: false,
      reason: "UNAUTHORIZED_SOURCE",
      req,
    };
  }
  return { verdict: "REQUIRED", authorized: true, reason: null, req };
}
