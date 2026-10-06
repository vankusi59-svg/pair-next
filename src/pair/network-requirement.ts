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
 * R2 closes two authority blockers (R3 removed the identity channel —
 * see below):
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
 * R3 closes the identity-authorization over-grant: operator-side
 *   authorization now derives ONLY from an explicit hostname/URL the
 *   operator goal literally writes. NO entity→hostname channel exists:
 *   no proper-noun / ALL-CAPS / camelCase / digit tokens, no
 *   label-membership matching (`mql5` in the goal NEVER authorizes
 *   `mql5.attacker.example`). A goal naming `mql5.com` authorizes
 *   `mql5.com` and its subdomains on DNS-label boundaries
 *   (`api.mql5.com` ✓; `mql5.attacker.example`, `evil-mql5.com`,
 *   `mql5.com.evil.org` ✗). Naming a subdomain authorizes only that
 *   subdomain and below — least authority, no sibling/parent widening.
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

/* ---------------- goal-side explicit-host extraction (R3) ---------------- */

/** Strict DNS label: 1–63 chars, alnum + interior hyphens only. */
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Bare dotted token (not URL-adjacent: no scheme/slash/word char at
 *  either edge, no `@` on the left so `user@host` never mints authority.
 *  A `.` on the right blocks the match only when it is token-continuing
 *  — followed by `.` or a label char — so a lone sentence-final `host.`
 *  period mints the host while a malformed dotted suffix (`host..foo`,
 *  `host...`, `host..`) fails closed instead of minting a valid prefix.
 *  Ambiguous by nature — it can equally be a hostname or a file name —
 *  so `bareTokenHost` decides conservatively. */
const BARE_DOTTED_RE = new RegExp(
  `(?<![\\w/.@-])${DNS_LABEL}(?:\\.${DNS_LABEL})+(?![\\w/-]|\\.(?=\\.|[\\w-]))`,
  "gi",
);

/** Filename-shaped final labels — a bounded FILENAME-syntax denylist, NOT
 *  a TLD allowlist. This is the mandated "structural rule that does not
 *  turn ordinary filenames into authority": a bare dotted token whose
 *  last label is a ubiquitous file extension (`math.txt`, `config.json`,
 *  `data.csv`) is treated as a file name, not an authorized host. The
 *  fail direction is DENY — a genuine host ending in one of these labels
 *  is simply not operator-authorized (fail-closed). Unlisted extensions
 *  still resolve as hosts — bounded residual, disclosed in the report. */
const FILE_EXTENSION_LABELS = new Set([
  "txt", "md", "markdown", "rst", "log", "json", "jsonl", "csv", "tsv",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "env", "lock", "tmp", "temp", "bak", "dat", "diff", "patch",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  "odp", "rtf", "tex", "epub", "html", "htm", "css",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "c", "h",
  "cpp", "hpp", "cs", "go", "rs", "rb", "php", "pl", "sh", "bash",
  "zsh", "bat", "ps1", "sql", "lua", "r", "swift", "kt", "scala",
  "ex", "exs", "erl", "hs", "mq4", "mq5", "mqh", "ex4", "ex5",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "tif",
  "tiff", "mp3", "wav", "ogg", "flac", "mp4", "mov", "avi", "mkv",
  "webm", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "jar", "war", "apk", "dmg", "iso", "img", "exe", "dll", "so",
  "dylib", "bin", "elf", "msi", "deb", "rpm", "db", "sqlite",
  "sqlite3", "mdb", "dump", "wasm", "map",
]);

/** Is a bare dotted token a GOAL-NAMED HOST (not a filename)? Structural,
 *  context-free, fail-closed:
 *   - every label must be a strict DNS label;
 *   - the final label must contain a letter (kills `1.2`, `192.168.1.1`);
 *   - the final label must not be a filename extension (`math.txt`,
 *     `report.csv` never authorize network access).
 *  Anything ambiguous resolves to null — the operator grants nothing. */
function bareTokenHost(token: string): string | null {
  const t = token.toLowerCase();
  if (t.length > 253) return null;
  const labels = t.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  }
  const last = labels[labels.length - 1] as string;
  if (!/[a-z]/.test(last)) return null;
  if (FILE_EXTENSION_LABELS.has(last)) return null;
  const h = stripWww(t);
  // after www-strip the remainder must still be a dotted host
  if (!h.includes(".")) return null;
  return h;
}

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
 *  though it carries a dot, unless the goal literally names that host
 *  (exact or label-boundary subdomain, per `goalAuthorizesHost`). */
export function isExternalShapedLocator(
  locator: string,
  goalHosts?: ReadonlySet<string>,
): boolean {
  const s = String(locator ?? "").trim();
  if (isUnambiguousExternalLocator(s)) return true;
  const h = requirementLocatorHost(s);
  return (
    h !== null && goalHosts !== undefined && goalAuthorizesHost(h, goalHosts)
  );
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
    // The URL charset stops at whitespace but admits sentence punctuation
    // a writer naturally follows a URL with (`https://h, and …`): strip a
    // trailing punctuation tail before parsing — it is never hostname.
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    try {
      const h = new URL(raw).hostname.toLowerCase();
      if (h) hosts.add(stripWww(h));
    } catch {
      const seg = requirementLocatorHost(raw);
      if (seg) hosts.add(seg);
    }
  }
  for (const m of g.matchAll(BARE_DOTTED_RE)) {
    const h = bareTokenHost(m[0]);
    if (h) hosts.add(h);
  }
  return hosts;
}

/** Does the operator goal authorize external access to this host?
 *  R3 final rule — exact match or DNS-label-boundary subdomain
 *  containment against a host the goal LITERALLY names:
 *    goal `mql5.com`      → allows `mql5.com`, `api.mql5.com`,
 *                          `www.mql5.com` (www is normalized away);
 *                          denies `mql5.attacker.example`,
 *                          `foo.mql5.example`, `mql5.com.evil.org`,
 *                          `evil-mql5.com`, `attacker-mql5.com`,
 *                          `mql5com.example`.
 *    goal `api.mql5.com`  → allows `api.mql5.com`, `x.api.mql5.com`;
 *                          does NOT widen to the parent or sibling
 *                          hosts — least authority.
 *  No identity/label membership exists — an entity token in the goal is
 *  never a hostname authorization. No host named → nothing external is
 *  authorized. */
export function goalAuthorizesHost(
  host: string,
  goalHosts: ReadonlySet<string>,
): boolean {
  const h = stripWww(String(host ?? "").toLowerCase());
  for (const g of goalHosts) {
    if (h === g || h.endsWith(`.${g}`)) return true;
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
  /** Hosts the operator goal literally names (extractGoalHosts) — the
   *  sole authorization surface. */
  goalHosts: ReadonlySet<string>;
  /** fresh is a retained input shape only: production callers pass
   *  `false` (persisted plans) — the fresh planner path now consumes
   *  `resolveFreshTaskNetworkAuthority` (planner-contract simplification:
   *  the structured field is optional advisory evidence, never a
   *  mandatory emission). Kept intact so persisted-plan and replay
   *  semantics stay byte-identical. */
  fresh: boolean;
}): NetworkTaskResolution {
  const { req, state, goalHosts, fresh } = args;
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
  if (!networkRequirementOperatorAuthorized(req, goalHosts)) {
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

/* ------------------------------------------------------------------ */
/* PLANNER-CONTRACT SIMPLIFICATION — the fresh planner path            */
/* ------------------------------------------------------------------ */

/** The FRESH-emission authority verdict. Under the simplified planner
 *  contract the structured `network_requirement` is OPTIONAL advisory
 *  evidence — a planner annotation is never what makes a task routable.
 *  PAIR derives the requirement deterministically from THREE bounded
 *  evidence sources, all goal/task text (never model-minted authority):
 *
 *    requires  = a VALID, non-contradictory structured requirement that
 *                semantically requires network
 *             || the instruction detector (taskRequiresNetworkAccess —
 *                same vocabulary persisted plans use)
 *             || the instruction names ≥1 host-shaped token
 *
 *    authorization (BLOCKER authority — fail closed):
 *      - a DECLARED source_locator host the goal never names is a minted
 *        hostname → INVALID unconditionally (planner declarations are
 *        never authorization — R3 authority preserved verbatim).
 *      - an INSTRUCTION-named host must be one the goal literally names
 *        whenever the goal names ≥1 host (a foreign host under a
 *        host-naming goal is an authority grab → INVALID). Under a
 *        host-free goal an instruction host is merely a source pick —
 *        ambient executor policy decides, the host itself authorizes
 *        nothing.
 *      - remaining authorization surfaces: the goal's own external-data
 *        demand (goalRequiresCurrentExternalData) or the task
 *        instruction satisfying the goal's external subject
 *        (instructionSatisfiesGoalSubject — the same subject binding the
 *        plan-level gate already uses).
 *      - a requirement with zero authorization evidence → INVALID
 *        (UNAUTHORIZED_SOURCE), the single fresh rejection class.
 *
 *  Annotation defects that used to kill fresh plans now degrade to
 *  "no structured evidence": missing/malformed/conflict fields and
 *  internally-contradictory ones are simply ignored — they can never
 *  mint authority and never kill a semantic plan. A planner NETWORK
 *  capability claim is likewise advisory routing metadata, not an
 *  authority grant: it is PAIR's verdict (bound deterministically
 *  upstream) that decides REQUIRED, and the claim is never rejected
 *  for contradicting an annotation PAIR ignores anyway.
 *
 *  REQUIRED      — needs network AND authorized → PAIR binds
 *                  NETWORK_ACCESS (servable executor policy decides).
 *  NOT_REQUIRED  — PAIR derived no network need; the task carries no
 *                  PAIR-bound network authority.
 *  INVALID       — UNAUTHORIZED_SOURCE only: a named host the operator
 *                  goal does not authorize, or a network requirement
 *                  with no authorization evidence of any kind. */
export type FreshNetworkTaskResolution =
  | { verdict: "REQUIRED" | "NOT_REQUIRED"; authorized: boolean; reason: null }
  | { verdict: "INVALID"; authorized: false; reason: "UNAUTHORIZED_SOURCE" };

export function resolveFreshTaskNetworkAuthority(args: {
  req: NetworkRequirement | null;
  state: NetworkRequirementFieldState;
  /** Hosts the operator goal literally names (extractGoalHosts). */
  goalHosts: ReadonlySet<string>;
  /** taskRequiresNetworkAccess(instruction) — precomputed by the caller
   *  (the detector lives in llm-planner; this module stays import-free
   *  of it). */
  instructionRequiresNetwork: boolean;
  /** goalRequiresCurrentExternalData(goal) — precomputed by the caller. */
  goalRequiresExternalData: boolean;
  /** instructionSatisfiesGoalSubject(instruction, goal) with the
   *  goal-actually-has-external-subject guard applied — precomputed by
   *  the caller (the binding helpers live in llm-planner). */
  instructionMatchesGoalSubject: boolean;
  /** The task instruction text — instruction-named hosts are harvested
   *  here with the same goal-host grammar. */
  instruction: string;
}): FreshNetworkTaskResolution {
  const { goalHosts } = args;
  // R1.A — the planner annotation (`args.req`, `args.state`) is
  // intentionally UNREAD for the verdict: under the simplified contract
  // it can neither GRANT nor DENY network authority. A wrong locator, a
  // malformed/conflicting/contradictory field, or a self-elevating
  // declaration all degrade to "no evidence" — the verdict is a pure
  // function of the canonical goal + task instruction text. Host
  // authorization stays fail-closed against hosts the INSTRUCTION
  // itself names (goal-text authority), never against annotation text.
  const instrHosts = extractGoalHosts(args.instruction);
  // R2 final fresh-host policy:
  //  - goal names hosts → every instruction-named host MUST be ⊆ them
  //  - goal names none but demands external/current data → instruction
  //    may SELECT its sources at plan level (runtime/executor policy
  //    stays authoritative — plan authority ≠ network permission)
  //  - goal names none and demands nothing external → instruction host
  //    is unauthorized
  if (instrHosts.size > 0 && goalHosts.size === 0) {
    if (!args.goalRequiresExternalData) {
      return { verdict: "INVALID", authorized: false, reason: "UNAUTHORIZED_SOURCE" };
    }
  } else {
    for (const h of instrHosts) {
      if (!goalAuthorizesHost(h, goalHosts)) {
        return { verdict: "INVALID", authorized: false, reason: "UNAUTHORIZED_SOURCE" };
      }
    }
  }
  // Derived requirement: only the instruction's own wording + its named
  // hosts can create network need — never the annotation.
  const requires = args.instructionRequiresNetwork || instrHosts.size > 0;
  if (!requires) {
    return { verdict: "NOT_REQUIRED", authorized: false, reason: null };
  }
  // Authorization surfaces (goal-text only): instruction-named host ⊆
  // goal hosts (already enforced above), the goal's own external-data
  // demand, or the instruction satisfying the goal's external subject.
  const authorized =
    (instrHosts.size > 0 && goalHosts.size > 0) ||
    args.goalRequiresExternalData ||
    args.instructionMatchesGoalSubject;
  if (!authorized) {
    return { verdict: "INVALID", authorized: false, reason: "UNAUTHORIZED_SOURCE" };
  }
  return { verdict: "REQUIRED", authorized: true, reason: null };
}
