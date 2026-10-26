/**
 * llm-planner.ts — PAIR OS vNext LLM plan proposer (P-UI-6 spec).
 *
 * Proposal-only: turns a natural-language goal into a governed task DAG by
 * asking an LLM (OpenAI-compatible chat/completions endpoint). Output is
 * untrusted: JSON-parsed, schema-checked, capability-whitelisted, size-capped;
 * malformed or violating output degrades to a deterministic fallback plan.
 * Never mutates canonical state, never picks executors — only proposes
 * `required_capabilities`; routing stays with CapabilityRouter.
 */

import { PolicyError } from "./errors.js";
import {
  extractTaskDataflow,
  isPureBookkeepingTask,
  inspectRawDeliveryEmissions,
  type RawDeliveryEmissionState,
} from "./plan-dataflow.js";
import { extractGoalContract } from "./goal-contract.js";
import {
  extractGoalHosts,
  NETWORK_REQUIREMENT_ERROR_KEY,
  networkRequirementFieldState,
  parseNetworkRequirementShape,
  resolveFreshTaskNetworkAuthority,
  type NetworkRequirement,
} from "./network-requirement.js";

export const LLM_PLANNER_MAX_INSTRUCTION = 2000;
export const LLM_PLANNER_DEFAULT_MAX_TASKS = 5;
export const LLM_PLANNER_DEFAULT_TIMEOUT_MS = 20000;
/** PRV2-A §D — the planner emits WORK tasks only; PAIR injects the
 *  canonical bookkeeping task at the canonicalize seam. A plan is
 *  degenerate when it carries ZERO usable work tasks (a bookkeeping-only
 *  plan still performs no real work). */
export const LLM_PLANNER_MIN_TASKS = 1;

/** PRV2-A §E — adaptive work-task budget. The deterministic bookkeeping
 *  task is NOT a work task and is never counted. */
export const WORK_TASK_HARD_CEILING = 12;
export const WORK_TASK_BUDGET_SIMPLE = 4;
export const WORK_TASK_BUDGET_MEDIUM = 6;
export const WORK_TASK_BUDGET_COMPLEX = 10;

/** Deterministic complexity score → bounded budget (exact rule, §E):
 *    score = wordCount + 4*numberedListMarkers + 2*connectiveHits
 *    score ≤ 40 → simple (4); ≤ 120 → medium (6); else complex (10).
 *  Pure function of the goal text — the model cannot request an
 *  arbitrary budget. */
export function deriveWorkTaskBudget(goal: string): number {
  const g = String(goal ?? "");
  const words = g.split(/\s+/u).filter(Boolean).length;
  const enumerations = Math.min(
    (g.match(/\b\d+\s*[.)]/gu) ?? []).length,
    10,
  );
  const connectives = (
    g
      .toLowerCase()
      .match(/(?<![\p{L}\p{N}])(?:và|and|then|sau đó|tiếp|rồi|cuối cùng|finally|also|song song)(?![\p{L}\p{N}])|[,;]/gu) ?? []
  ).length;
  const score = words + 4 * enumerations + 2 * connectives;
  if (score <= 40) return WORK_TASK_BUDGET_SIMPLE;
  if (score <= 120) return WORK_TASK_BUDGET_MEDIUM;
  return WORK_TASK_BUDGET_COMPLEX;
}

/** Effective budget = min(derived, configuredMax) under the absolute
 *  hard ceiling (12 work tasks). A configured cap only tightens. */
export function resolveWorkTaskBudget(goal: string, configuredMax?: number): number {
  const ceiling = Math.min(
    configuredMax ?? WORK_TASK_HARD_CEILING,
    WORK_TASK_HARD_CEILING,
  );
  return Math.max(1, Math.min(deriveWorkTaskBudget(goal), ceiling));
}

/** PRV2-A §D — a model-emitted task is bookkeeping-shaped when its
 *  filtered (allowed-vocabulary) capabilities are exactly
 *  {AUTOMATON_TASK_EXECUTION}: the ONLY thing it could do is PAIR's
 *  bookkeeping. PAIR injects bookkeeping itself, so such a task is
 *  normalized away at the canonicalize seam (never two bookkeeping
 *  authorities in one plan). */
export function isBookkeepingShapedTask(
  task: Record<string, unknown>,
  allowedCapabilities: string[],
): boolean {
  const capSet = new Set(allowedCapabilities);
  const caps = Array.isArray(task.required_capabilities)
    ? task.required_capabilities.map((c) => String(c)).filter((c) => capSet.has(c))
    : [];
  if (!caps.length || !caps.every((c) => c === "AUTOMATON_TASK_EXECUTION")) {
    return false;
  }
  return isPureBookkeepingTask({
    required_capabilities: caps,
    metadata: task.metadata,
  });
}

/** PRV2-A R1.A — AUTOMATON_TASK_EXECUTION is PAIR-reserved, not merely
 *  prompt-forbidden. A model emission is RESERVED-MISUSE when it carries
 *  AUTOMATON anywhere in its raw capability list and is NOT a pure
 *  bookkeeping-shaped task (the only emission PAIR is allowed to
 *  normalize away). Returns the task_key of the first misuse, else null.
 *  Callers must reject deterministically — never strip AUTOMATON from a
 *  mixed task and pretend the model requested something different. */
export function reservedAutomatonMisuseKey(
  rawTasks: Array<Record<string, unknown>>,
): string | null {
  for (const t of rawTasks ?? []) {
    const rawCaps = Array.isArray(t?.required_capabilities)
      ? (t.required_capabilities as unknown[]).map((c) => String(c))
      : [];
    if (!rawCaps.includes("AUTOMATON_TASK_EXECUTION")) continue;
    const pure = isPureBookkeepingTask({
      required_capabilities: rawCaps,
      metadata: t?.metadata,
    });
    if (!pure) return String(t?.task_key ?? "?");
  }
  return null;
}

/** Typed warning code for planner-layer reserved-misuse rejections. */
export const LLM_PLAN_RESERVED_CAPABILITY_WARNING =
  "LLM_PLAN_RESERVED_CAPABILITY_AUTOMATON";

/* ---------------- PRV2-A R2/R3 — current/external-data intent -------------
 * One canonical, conservative, deterministic detector distinguishing
 * LOCAL_CURRENT_STATE from CURRENT_EXTERNAL_INFORMATION. It powers the
 * canonical planner gate: a goal that explicitly needs current/external
 * data demands a legitimate NETWORK_ACCESS data-gathering task in the
 * canonical work plan, and a task instruction that explicitly requests
 * live/web fetching must carry NETWORK_ACCESS itself.
 *
 * R3.A — generic `current/currently/hiện tại` is LOCAL by default: it
 * cannot become external-data authority merely next to broad output
 * nouns (report/data/information), and any explicit local source
 * (repo/branch/workspace/file/CSV/code/project...) suppresses the
 * requirement entirely unless an online marker is present. Generic
 * current only counts with an explicit retrieval verb + retrievable
 * object ("get the current gold price"), or research intent against an
 * EXTERNAL subject ("analyze the current market").
 *
 * R3.B — research/retrieval intent covers research/analyze/nghiên cứu/
 * phân tích: the operator need not literally say fetch/search/internet.
 * A recency marker + research intent + external subject
 * ("research the latest GPT models") is current/external-data work. */

/** Strong recency markers — unambiguous "newest/now" vocabulary that can
 *  lift a research or retrieval request into current-data territory. */
const STRONG_CURRENCY_RE =
  /\b(today|tonight|latest|newest|live|real[-\s]?time|up[-\s]?to[-\s]?date|breaking|right\s+now|this\s+week|current[-\s]?week)\b|hôm nay|mới nhất|mới đây|gần đây|trực tiếp|bây giờ|lúc này|ngày hôm nay|tuần này|tuần hiện tại/iu;

/** Non-week strong markers — always free recency. Week markers are
 *  evaluated separately because "tuần này"/"this week" can also mark
 *  WHEN work happens, not that the subject is current (R3-F6). */
const STRONG_NONWEEK_CURRENCY_RE =
  /\b(today|tonight|latest|newest|live|real[-\s]?time|up[-\s]?to[-\s]?date|breaking|right\s+now)\b|hôm nay|mới nhất|mới đây|gần đây|trực tiếp|bây giờ|lúc này|ngày hôm nay/iu;

/** Current-week recency markers (global — scanned per clause). */
const WEEK_CURRENCY_RE =
  /\bthis\s+week\b|\bcurrent[-\s]?week\b|tuần\s+này|tuần\s+hiện\s+tại/giu;

/** R3-F6 — schedule/meeting/delivery-deadline roles: when one of these
 *  governs a week marker inside the same clause, the marker binds the
 *  EVENT time ("buổi họp tuần này", "delivered this week"), not the
 *  researched subject. Bounded rule — the schedule word must precede
 *  the week marker inside the clause; a week marker in a clause
 *  without a preceding schedule role keeps full recency authority. */
const SCHEDULE_ROLE_RE =
  /(?<![\p{L}\p{N}])(họp|meeting|schedule[sd]?|lịch|deadline|hạn|nộp|bàn\s+giao|giao\s+(?!dịch)|deliver(?:ed|y|s|ing)?|submit(?:ted|s|ting)?|present(?:ed|s|ing|ation)?|trình\s+bày|gửi|send(?:s|t|ing)?|đăng|post(?:ed|s|ing)?|publish(?:ed|es|ing)?|share[sd]?)(?![\p{L}\p{N}])/iu;

/** TRUE when the goal carries at least one week-recency marker that is
 *  NOT governed by a schedule/deadline role within its own clause. */
function hasUnboundWeekCurrency(goal: string): boolean {
  const clauses = String(goal ?? "").split(/[,.;:!?\n]+/);
  for (const clause of clauses) {
    WEEK_CURRENCY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WEEK_CURRENCY_RE.exec(clause)) !== null) {
      const before = clause.slice(Math.max(0, m.index - 32), m.index);
      if (!SCHEDULE_ROLE_RE.test(before)) return true;
    }
  }
  return false;
}

/** Generic current-state markers — ambiguous LOCAL-or-EXTERNAL; never
 *  sufficient alone (see R3.A rules). */
const GENERIC_CURRENT_RE = /\bcurrent(?:ly)?\b|hiện tại|hiện giờ|hiện nay/iu;

/** Explicit online/web markers — never bare "web" (a "web app" is not a
 *  network request) and never "website". */
const ONLINE_RE =
  /\b(the\s+web|world\s+wide\s+web|internet|online|web\s+search|search\s+the\s+web|google|bing|wikipedia|github)\b|trên mạng|trên internet|mạng internet/iu;

/** Explicit local sources — the "current state" lives on disk/in the
 *  repo, not on the network. Presence suppresses the requirement unless
 *  an online marker coexists. */
const LOCAL_SOURCE_RE =
  /\b(repos?|repository|branch(?:es)?|workspace|csv|source\s+code|codebase|code|project(?:\s+state)?|commits?|diffs?|modules?|director(?:y|ies)|folders?|logs?|local(?:ly)?|disk|filesystem|monorepo)\b|mã nguồn|thư mục|dự án|nhánh|cục bộ|\brepo\b|(?:local|cục\s+bộ)\s+(?:[\w.]+\s+){0,3}(?:files?|tệp(?:\s+tin)?)\b|\b(?:files?|tệp(?:\s+tin)?)\s+(?:cục\s+bộ|local|trên\s+disk|trong\s+repo|dữ\s+liệu|input)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:trong|từ|of|in|inside|within|from|on|read(?:ing)?|đọc|open(?:ing)?|mở)\s+(?:a\s+|an\s+|the\s+|this\s+|một\s+|các\s+|những\s+)?(?:files?|tệp(?:\s+tin)?)\b|(?:files?|tệp(?:\s+tin)?)\s+(?:input|data)\b/iu;

/** Information-retrieval verbs. Word-bounded so "fetched", "scraper"
 *  do NOT match — only an explicit request to retrieve. */
const FETCH_VERB_RE =
  /\b(fetch(?:es)?|get|gets|getting|retrieve[sd]?|search(?:es)?|look\s?up|lookup|find|finds|browse[sd]?|scrape[sd]?|checks?|checking|gather(?:s|ing|ed)?|collect(?:s|ed|ing)?|quer(?:y|ies|ied)|pull(?:s|ing)?|download(?:s|ed|ing)?|tìm|tra|lấy)\b|tìm kiếm|tra cứu|kiểm tra|thu thập|xem tin/iu;

/** Research/analysis intent — the R3.B retrieval-class verbs that are
 *  not literal fetch words. */
const RESEARCH_RE =
  /\b(research(?:es|ed|ing)?|analyz(?:e[sd]?|ing)|analysis|study|studies|studied|studying|investigat(?:e[sd]?|ing)|survey(?:s|ed|ing)?|compar(?:e[sd]?|ing)|review(?:s|ed|ing)?)\b|nghiên cứu|phân tích|đánh giá|so sánh|khảo sát|tổng hợp/iu;

/** Subjects that only exist on the outside — versions, releases,
 *  products, prices, listings... A recency-marked research/fetch request
 *  about these is CURRENT_EXTERNAL_INFORMATION, not local state. */
const EXTERNAL_SUBJECT_RE =
  /\b(models?|versions?|releases?|apis?|products?|prices?|news|weather|rates?|exchanges?|forex|stocks?|markets?|crypto(?:currency)?|bitcoin|btc|eth|ethereum|gold|xau|xauusd|ea|mql[45]|packages?|listings?|frameworks?|tools?|providers?|offerings?|announcements?|feeds?|articles?|headlines?|trends?|quotes?|forecasts?|outlook|scores?|libraries?|sdks?|plugins?|services?|competitors?|events?)\b|giá|tin tức|thời tiết|thị trường|tỷ giá|mô hình|phiên bản|tin\b|\bbáo\b/iu;

/** Broad retrievable nouns — things one could gather, but weak alone
 *  (a "report" is usually authored, not fetched). */
const DATA_OBJECT_RE =
  /\b(price[sd]?|rates?|news|weather|stocks?|markets?|headlines?|trends?|updates?|information|data|reports?|scores?|results?|quotes?|articles?|forex|exchange|forecast|outlook|tin)\b|giá|tin tức|thời tiết|thị trường|tỷ giá|dữ liệu|thông tin|báo cáo|\bbáo\b/iu;

/** Does the GOAL explicitly intend current/external data? */
export function goalRequiresCurrentExternalData(goal: string): boolean {
  const g = String(goal ?? "");
  const online = ONLINE_RE.test(g);
  const strong =
    STRONG_NONWEEK_CURRENCY_RE.test(g) || hasUnboundWeekCurrency(g);
  const generic = GENERIC_CURRENT_RE.test(g);
  if (!online && !strong && !generic) return false;
  // R3.A — LOCAL_CURRENT_STATE: an explicit local source without an
  // online marker can never be an external-data requirement.
  if (LOCAL_SOURCE_RE.test(g) && !online) return false;
  const fetch = FETCH_VERB_RE.test(g);
  const research = RESEARCH_RE.test(g);
  const ext = EXTERNAL_SUBJECT_RE.test(g);
  const obj = DATA_OBJECT_RE.test(g);
  // Online or strong recency: retrieval/research intent + retrievable
  // subject → CURRENT_EXTERNAL_INFORMATION.
  if (online || strong) return (fetch || research) && (ext || obj);
  // Generic `current` only: explicit fetch verb + retrievable object
  // ("get the current gold price"), or research intent against an
  // EXTERNAL subject — never against a broad output noun.
  return (fetch && (ext || obj)) || (research && ext);
}

/** Does the task instruction explicitly request live/web fetching or
 *  recency-qualified research? Such a task MUST itself carry
 *  NETWORK_ACCESS. */
export function taskRequiresNetworkAccess(instruction: string): boolean {
  const t = String(instruction ?? "");
  const online = ONLINE_RE.test(t);
  const strong = STRONG_CURRENCY_RE.test(t);
  const generic = GENERIC_CURRENT_RE.test(t);
  if (!online && !strong && !generic) return false;
  if (LOCAL_SOURCE_RE.test(t) && !online) return false;
  const fetch = FETCH_VERB_RE.test(t);
  const research = RESEARCH_RE.test(t);
  if (online || strong) return fetch || research;
  // generic current: explicit fetch verb, or research on an external
  // subject — "analyze the current data" is local work, not misuse.
  return fetch || (research && EXTERNAL_SUBJECT_RE.test(t));
}

/** Does the instruction describe data-gathering work? Used to prove a
 *  NETWORK_ACCESS task is a legitimate gatherer — not a dummy carrying
 *  the capability. */
export function instructionIsDataGathering(instruction: string): boolean {
  const t = String(instruction ?? "");
  const fetch = FETCH_VERB_RE.test(t);
  const research = RESEARCH_RE.test(t);
  return (
    (fetch || research) &&
    (DATA_OBJECT_RE.test(t) ||
      EXTERNAL_SUBJECT_RE.test(t) ||
      ONLINE_RE.test(t) ||
      STRONG_CURRENCY_RE.test(t) ||
      GENERIC_CURRENT_RE.test(t))
  );
}

/* ---------------- PRV2-A R4 — goal↔task subject binding -------------------
 * The NETWORK_ACCESS task satisfying a goal-level current-data
 * obligation must gather data RELEVANT to that obligation. A bounded
 * lexical proof: extract the canonical external-subject lexemes present
 * in each text (same vocabulary family as the detector, singular-
 * normalized, small alias map) and require a non-empty overlap. No
 * semantic classifier; one shared canonical lexeme is sufficient
 * binding — conservative like the rest of the detector. */

const SUBJECT_LEXEMES = new Set([
  "model", "version", "release", "api", "product", "price", "news",
  "weather", "rate", "exchange", "forex", "stock", "market", "crypto",
  "bitcoin", "ethereum", "gold", "ea", "mql4", "mql5", "package",
  "listing", "framework", "tool", "provider", "offering", "announcement",
  "feed", "article", "headline", "trend", "quote", "forecast", "outlook",
  "score", "library", "sdk", "plugin", "service", "competitor", "event",
  "update", "information", "data", "report", "result",
]);

const SUBJECT_ALIAS: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", xau: "gold", xauusd: "gold",
};

/** Vietnamese subject phrases → canonical English keys so a VI goal
 *  binds a VI task by subject, not by literal wording. */
const VI_SUBJECT_PHRASES: Array<[RegExp, string]> = [
  [/mô hình/iu, "model"], [/phiên bản/iu, "version"],
  [/tin tức|\btin\b|\bbáo\b/iu, "news"], [/thời tiết/iu, "weather"],
  [/thị trường/iu, "market"], [/tỷ giá/iu, "rate"],
  [/giá/iu, "price"], [/\bvàng\b/iu, "gold"],
  [/dữ liệu/iu, "data"], [/thông tin/iu, "information"],
  [/báo cáo/iu, "report"],
];

/** Canonical external-subject keys present in a text (e.g. "models" →
 *  "model", "btc" → "bitcoin", "giá vàng" → {"price","gold"}). */
export function externalSubjectKeys(text: string): Set<string> {
  const t = String(text ?? "");
  const keys = new Set<string>();
  for (const m of t.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    let key = SUBJECT_ALIAS[m[0]] ?? m[0];
    if (!SUBJECT_LEXEMES.has(key) && key.endsWith("s")) {
      const stem = key.slice(0, -1);
      if (SUBJECT_LEXEMES.has(stem)) key = stem;
    }
    if (SUBJECT_LEXEMES.has(key)) keys.add(key);
  }
  for (const [re, key] of VI_SUBJECT_PHRASES) if (re.test(t)) keys.add(key);
  return keys;
}

/* ---------------- PRV2-A R5 — subject identity anchors -------------------
 * A generic class match alone cannot prove the NETWORK gatherer is
 * fetching the goal's actual subject: "the latest GPT models" is not
 * satisfied by "the latest Claude models" though both share `model`.
 * Anchors = canonical named-subject lexemes + capitalized tokens
 * (proper names / acronyms) minus detector vocabulary and function
 * words. When the goal has ≥1 usable anchor the task must preserve at
 * least one; when it has none, the R4 class-overlap rule applies. */

/** Canonical named subjects — lowercase-mentionable identities. */
const ANCHOR_LEXEMES = new Set([
  "gold", "bitcoin", "ethereum", "silver", "oil", "eurusd", "usdjpy",
  "ea", "mql4", "mql5",
]);

/** Vocabulary + function words never usable as an identity anchor. */
const ANCHOR_STOP = new Set([
  ...SUBJECT_LEXEMES,
  // retrieval/research intent
  "research", "analyzes", "analyzed", "analyzing", "analysis", "study",
  "studies", "investigate", "survey", "compare", "comparing", "review",
  "fetch", "fetches", "get", "gets", "getting", "retrieve", "retrieves",
  "retrieved", "search", "searches", "look", "lookup", "find", "finds",
  "browse", "scrape", "check", "checks", "checking", "gather", "gathers",
  "gathered", "gathering", "collect", "collects", "collected",
  "collecting", "query", "queries", "pull", "pulls", "pulling",
  "download", "downloads", "downloaded", "downloading",
  // work verbs
  "write", "writes", "writing", "create", "creates", "creating",
  "produce", "produces", "producing", "generate", "generates", "draw",
  "draws", "stage", "stages", "staging", "use", "uses", "using", "read",
  "reads", "reading", "summarize", "summarizes", "return", "returns",
  "record", "records", "list", "lists", "compile", "compiles", "build",
  "builds", "deploy", "deploys", "run", "runs", "send", "sends", "post",
  "posts", "translate", "translates", "extract", "extracts", "compute",
  "computes", "evaluate", "evaluates", "predict", "parse", "parses",
  "validate", "verify", "describe", "explain", "plot", "plots",
  "visualize", "recommend", "suggest", "analyze",
  // outcome/fulfillment verbs (Semantic Planning V1) — an action word
  // sentence-initially capitalized ("Grow my channel") is never a
  // subject identity anchor
  "grow", "grows", "grew", "grown", "growing", "growth", "increase",
  "increases", "increased", "increasing", "boost", "boosts", "gain",
  "gains", "achieve", "achieves", "reach", "reaches", "attain",
  "acquire", "acquires", "attract", "attracts", "earn", "earns",
  "expand", "expands", "scale", "scales", "improve", "improves",
  "raise", "raises", "drive", "drives", "convert", "converts",
  "recruit", "recruits", "onboard", "onboards", "execute", "executes",
  "operate", "operates", "deliver", "delivers", "launch", "launches",
  "perform", "performs", "conduct", "conducts", "measure", "measures",
  "quantify", "estimate", "estimates", "forecast", "forecasts",
  "monitor", "monitors", "track", "tracks",
  // recency / shape words
  "today", "tonight", "latest", "newest", "live", "breaking", "current",
  "currently", "online", "recent", "new", "real", "time", "up", "date",
  "right", "now", "free", "paid", "top", "best", "main", "key",
  // function words + misc
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at",
  "from", "with", "about", "into", "by", "is", "are", "was", "were",
  "be", "been", "it", "its", "this", "that", "these", "those", "you",
  "your", "we", "our", "they", "their", "as", "if", "then", "than",
  "so", "such", "all", "any", "both", "each", "every", "no", "not",
  "only", "same", "own", "over", "per", "via", "vs", "etc",
  "sources", "findings", "summary", "note", "placeholder", "step",
  "task", "goal", "plan", "output", "input", "instruction", "artifact",
  "artifacts", "file", "files", "text", "content", "gửi", "các", "và",
  // local-source vocabulary — never an external identity
  "repo", "repository", "branch", "workspace", "csv", "code",
  "project", "commits", "commit", "diffs", "diff", "modules", "module",
  "directory", "folders", "folder", "logs", "log", "local", "disk",
  "filesystem", "monorepo", "source", "open",
  // quantity bounds — modifiers, never subject identity
  "least", "most", "min", "max", "minimum", "maximum", "fewer",
  "exactly", "exact", "more", "less", "fewest", "đúng", "chính",
  "xác", "tối", "đa", "quá", "vượt", "hơn", "nhất", "nhiều",
  "không", "ngoài", "trên", "dưới",
  // K′ audit — clause-initial connectives orphaned by a prohibition
  // split ("Research crypto but…") or leading a subordinate clause are
  // syntax, never subject identity; the ±2 context-anchor scan used to
  // promote them into required (uncoverable) anchors.
  "but", "however", "nevertheless", "nonetheless", "whereas", "while",
  "yet", "though", "although", "nor",
  // fulfill-class verbs — "Carry out…" / "Roll out…" lead work, never
  // name a subject.
  "carry", "carries", "roll", "rolls",
  // Vietnamese action-verb syllables that are pure ASCII — a diacritic
  // fragment can never anchor (token test rejects non-ASCII), but
  // clause-initial "Thu hút…" minted a false `thu` anchor and rejected
  // genuine fulfillment tasks. Mirrors CONTENT_TOKEN_VI_ACTION_STOP.
  "thu", "tra", "xem", "ghi", "gia", "khai",
]);

/** Canonical form of an anchor-lexeme token (alias + plural stem). */
function anchorLexeme(lc: string): string | null {
  const a = SUBJECT_ALIAS[lc] ?? lc;
  if (ANCHOR_LEXEMES.has(a)) return a;
  if (a.endsWith("s") && ANCHOR_LEXEMES.has(a.slice(0, -1))) {
    return a.slice(0, -1);
  }
  return null;
}

/** Subject identity anchors present in a text: canonical anchor
 *  lexemes + capitalized-name tokens (proper nouns/acronyms), alias-
 *  normalized (BTC→bitcoin, XAUUSD→gold). */
export function subjectAnchors(text: string): Set<string> {
  const t = String(text ?? "");
  const anchors = new Set<string>();
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    const lc = w.toLowerCase();
    // Canonical anchor lexemes — alias- and plural-normalized so
    // "EAs" ≡ "ea" exactly like "EA" does (PRV2-B).
    const lex = anchorLexeme(lc);
    if (lex) {
      anchors.add(lex);
      continue;
    }
    // capitalized candidate: proper noun or acronym — never vocabulary,
    // and pure ASCII so a diacritic-bearing word-fragment ("Nghi" from
    // "Nghiên") can never become a false anchor.
    if (
      w !== lc &&
      w.length >= 2 &&
      /[A-Z]/.test(w) &&
      /^[A-Za-z0-9]+$/.test(w)
    ) {
      if (!ANCHOR_STOP.has(lc)) anchors.add(SUBJECT_ALIAS[lc] ?? lc);
    }
  }
  for (const [re, key] of VI_SUBJECT_PHRASES) {
    if (re.test(t) && ANCHOR_LEXEMES.has(key)) anchors.add(key);
  }
  // Case-insensitive context anchors: a non-vocabulary token adjacent
  // to a subject-class term (±2 positions) names the external subject
  // — "gpt models", "openai api" — regardless of casing.
  const toks: { w: string; i: number }[] = [];
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
    toks.push({ w: m[0], i: m.index ?? 0 });
  }
  const classAt = toks.map(({ w }) => {
    let lc = w.toLowerCase();
    lc = SUBJECT_ALIAS[lc] ?? lc;
    if (!SUBJECT_LEXEMES.has(lc) && lc.endsWith("s")) {
      const stem = lc.slice(0, -1);
      if (SUBJECT_LEXEMES.has(stem)) lc = stem;
    }
    return SUBJECT_LEXEMES.has(lc);
  });
  for (let i = 0; i < toks.length; i++) {
    if (!classAt[i]) continue;
    // The subject identity is the modifier ADJACENT to the class term —
    // scan outward for the single nearest candidate in each direction.
    // Stop words, class terms, extension fragments and non-ASCII tokens
    // terminate the scan (they bound the noun phrase); pure digits are
    // skipped so a version tail ("gpt 4 models") still reaches "gpt".
    // Generic descriptors two positions away ("commercial gpt models")
    // are therefore never anchors.
    for (const dir of [-1, 1] as const) {
      for (let j = i + dir; j >= 0 && j < toks.length && Math.abs(j - i) <= 2; j += dir) {
        if (classAt[j]) break;
        const w = toks[j].w;
        const lc = SUBJECT_ALIAS[w.toLowerCase()] ?? w.toLowerCase();
        if (/^[0-9]+$/.test(w)) continue;
        if (
          w.length < 2 ||
          ANCHOR_STOP.has(lc) ||
          !/^[A-Za-z0-9]+$/.test(w) ||
          t[toks[j].i - 1] === "."
        ) {
          break;
        }
        anchors.add(lc);
        break;
      }
    }
  }
  return anchors;
}

/** Does the task instruction gather the subject the goal's current-data
 *  obligation is about? R5: when the goal has usable identity anchors
 *  the task must share at least one (generic class overlap is NOT
 *  sufficient); otherwise the R4 class-overlap rule applies. */
export function instructionSatisfiesGoalSubject(
  instruction: string,
  goal: string,
): boolean {
  const goalAnchors = subjectAnchors(goal);
  if (goalAnchors.size > 0) {
    const taskAnchors = subjectAnchors(instruction);
    for (const a of taskAnchors) if (goalAnchors.has(a)) return true;
    return false;
  }
  const goalKeys = externalSubjectKeys(goal);
  if (goalKeys.size === 0) return true;
  const taskKeys = externalSubjectKeys(instruction);
  for (const k of taskKeys) if (goalKeys.has(k)) return true;
  return false;
}

/** P-REASK — bounded deterministic rejection feedback PAIR hands back to
 *  the SAME planner candidate on its one canonical-rejection re-ask.
 *  Built ONLY from PAIR-owned evidence: the exact typed validation code
 *  and the task-keyed sanitize markers (DROP_*, DEP_*, REPAIRED_*). Never
 *  raw model output, task instruction bodies, exception text, or secrets. */
export interface PlannerRejectionContext {
  validation_code: string;
  task_warnings: string[];
  /** P-REASK R4 — one bounded line built from allowlisted structured gate
   *  detail (task/artifact/requirement identifiers), or the validation_code
   *  itself as fallback. Never raw exception text, instructions, plan JSON,
   *  requirement text, or secrets. */
  detail?: string;
  /** P18.2 — absent = same-run REASK (this candidate's own plan was just
   *  rejected). "PRIOR_RUN" = cross-run feedback: a DIFFERENT, earlier
   *  planner run for the same work item was rejected — possibly a
   *  different candidate/model. Prompt phrasing differs; everything else
   *  (sanitize bounds, minimal-repair tail) is identical. */
  origin?: "PRIOR_RUN";
}

export interface LlmPlannerConfig {
  /** Provider chat/completions URL (P6 endpoint_reference). */
  endpoint: string;
  /** Env var NAME holding the API key — never the value itself. */
  credentialEnv: string;
  model: string;
  maxTasks?: number;
  /** Whitelist of capabilities the LLM may request (non-empty per task). */
  allowedCapabilities: string[];
  /** Each entry = one executor's capability list; a task whose caps are not
   *  jointly servable by a single entry is dropped (DROP_UNSERVABLE_CAPS). */
  capabilitySets?: string[][];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | ((name: string) => string | undefined);
  /** Injectable for tests — defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** P-REASK — hard provider-request bound for THIS invocation. The
   *  default preserves the historical ≤2-call contract (one internal
   *  retry on degenerate output); a rejection-feedback re-ask passes 1 —
   *  exactly one provider request, never a recursive retry layer. */
  maxProviderRequests?: number;
  /** AUDIT R1 F3 — absolute run deadline (epoch ms) propagated from the
   *  Planner Pool invocation. `timeoutMs` bounds a single request measured
   *  at call time, but the internal retry loop used to be able to START a
   *  fresh provider request after the run deadline; a request may now only
   *  begin while `Date.now() < deadlineMs`, and each request's clock is
   *  min()'d against the remaining deadline. */
  deadlineMs?: number;
  /** AUDIT R1 F4 — mutable counter the Planner Pool owns per attempt;
   *  incremented at the exact point this transport initiates a provider
   *  request, so the settled attempt row records requests that PROVABLY
   *  ran — never the attempt-row count. */
  providerCounter?: { requests: number };
  /** F3 — bounded structured failure context on a REPLAN: the planner must
   *  propose a feasible ALTERNATIVE, never a semantic re-emission of the
   *  failed plan; the rejected digests are named in the prompt. */
  replanContext?: {
    recovery_id?: string;
    failure_signature?: string | null;
    failure_class: string;
    dependency_reason?: string | null;
    failed_task_key?: string | null;
    failed_plan_semantic_digest?: string | null;
    rejected_semantic_digests?: string[];
  };
  /** P-REASK — bounded rejection feedback on the ONE canonical-rejection
   *  re-ask: MINIMAL-REPAIR semantics (fix the named defect, preserve all
   *  other structure) — never F3's alternative-plan semantics. */
  rejectionContext?: PlannerRejectionContext;
  /** R1 — the provenance-bound operator goal: the ONLY text allowed to
   *  mint Goal Contract requirements, host/network authorization, and
   *  the work-task budget inside the prompt. `goal` remains the full
   *  mission text the model reads (envelope context included); absent
   *  → `goal` itself is the operator request. */
  authorityGoal?: string;
  /** EXTERNAL_INPUT_AWARENESS — the eligible cross-mission input set the
   *  canonicalizer will bind against, rendered verbatim into the prompt
   *  so the model can consume a real sibling artifact by exact logical
   *  name instead of guessing a filename from the goal text. Context
   *  only — the binding authority stays the canonicalizer's re-proof. */
  externalInputArtifacts?: ReadonlyArray<{
    logical_name: string;
    source_mission_id?: string;
    source_task_id?: string;
  }>;
  /** Semantic Planning V1 — the PRE-RENDERED advisory planning-context
   *  block (renderPlanningContextBlock output, bounded). Advisory data
   *  only: it informs planning but can never mint authority, widen
   *  scope, or substitute for the Goal Contract. Assembled at the async
   *  planner seams (or pinned on a durable replan_generation row) —
   *  never inside the synchronous canonicalizer. */
  planningContextBlock?: string;
  /** P18.6 — the PRE-RENDERED advisory semantic goal-interpretation
   *  block (renderGoalIntentBlock output, bounded). Same advisory
   *  discipline: interpretation informs decomposition, never mints or
   *  satisfies requirements — the GOAL CONTRACT remains sole
   *  authority. Assembled at the async seams / pinned on the durable
   *  replan_generation row alongside planning_context. */
  semanticIntentBlock?: string;
}

export interface LlmPlanResult {
  tasks: Array<Record<string, unknown>>;
  source: "LLM" | "FALLBACK";
  model?: string;
  warnings: string[];
  /** HOTFIX 1 R1/R2 — TRUE raw delivery-emission evidence captured on
   *  the parsed provider JSON BEFORE sanitizePlan: the count of tasks
   *  that carried a TELEGRAM_DELIVERY token in ANY shape, plus the
   *  tri-state verdict (ABSENT = proven omission, PRESENT = proven
   *  emission, INDETERMINATE = uninspected content — never a proven
   *  R=0). Descriptive planner provenance only — zero delivery
   *  authority. */
  raw_delivery_emission_count?: number;
  raw_delivery_emission_state?: RawDeliveryEmissionState;
}

type RawTask = {
  task_key?: unknown;
  title?: unknown;
  task_instruction?: unknown;
  required_capabilities?: unknown;
  depends_on?: unknown;
  /** P-COVMAP — the model-facing coverage-map field (top-level is
   *  authoritative; the strict Codex schema can only emit top-level).
   *  Normalized into `metadata.pair_coverage` by sanitizePlan. */
  pair_coverage?: unknown;
  /** R1 — the model-facing structured network/source requirement (same
   *  top-level-authoritative convention as pair_coverage). Normalized
   *  into `metadata.network_requirement` by sanitizePlan. */
  network_requirement?: unknown;
  metadata?: unknown;
};

/** Minimal safe plan — same PAIR_NATIVE contract as the template planner. */
export function fallbackTasks(goal: string): Array<Record<string, unknown>> {
  return [
    {
      task_key: "T1",
      title: "record mission goal",
      task_instruction: goal,
      required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
      depends_on: [],
      metadata: {
        expected_output_contract: {
          type: "TASK_RESULT",
          worker_spec: {
            ops: [
              { op: "write_text_file", path: "mission_goal.txt", content: goal, idempotency_class: "WRITE", risk_class: "MEDIUM" },
              { op: "finish", result: { summary: "goal recorded" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
            ],
            limits: { max_ops: 4, timeout_seconds: 30 },
            allowed_ops: ["write_text_file", "finish"],
          },
        },
      },
    },
  ];
}

function envGet(env: LlmPlannerConfig["env"], name: string): string | undefined {
  if (!env) return process.env[name];
  return typeof env === "function" ? env(name) : env[name];
}

/** Extract the first balanced {...} JSON object from LLM text output.
 *  Exported as extractPlanJson for the Codex CLI planner transport
 *  (CPL-1) — every transport parses plan text through ONE seam. */
function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new PolicyError("LLM_PLAN_NO_JSON", "planner.parse");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new PolicyError("LLM_PLAN_UNBALANCED_JSON", "planner.parse");
}
export const extractPlanJson = extractJson;

/**
 * Capabilities served by remote executors whose outputs live on the remote
 * side (returned as refs, not local workspace files). F2: a downstream task
 * may consume a remote artifact ONLY through an explicitly declared
 * produces/consumes edge — undeclared remote coupling stays rejected.
 */
const REMOTE_CAPS = new Set([
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
]);

/**
 * Validate + clamp raw LLM tasks into a safe proposal. Rules (spec §2.1):
 * task_key T\d+ unique; depends_on only references earlier keys (acyclic);
 * required_capabilities ⊆ whitelist, non-empty; instruction ≤ cap;
 * count ≤ maxTasks; invalid tasks dropped (later deps re-pointed or dropped).
 * + every task's capability set must be jointly servable by ≥1 executor
 * (capabilitySets param, each entry = one executor's capability list); and
 * remote-capability tasks must be leaves — no later task may depend on them.
 */
export function sanitizePlan(
  raw: RawTask[],
  allowedCapabilities: string[],
  maxTasks: number,
  capabilitySets?: string[][],
): { tasks: Array<Record<string, unknown>>; warnings: string[] } {
  const capSet = new Set(allowedCapabilities);
  const warnings: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const remoteKeys = new Set<string>();
  const rawByKey = new Map(raw.map((t) => [String(t.task_key ?? ""), t]));
  /** F2 §20 — sanitize-stage edge check via the same dataflow model the
   *  committed plan applies later (planner-supplied pair_dataflow is a
   *  hint only; assertPlanDataflow re-verifies without reserved keys). */
  const candidateTaskDataflow = (t: Record<string, unknown>) => {
    try {
      return extractTaskDataflow(t);
    } catch {
      return { produces: [] as string[], consumes: [] as string[] };
    }
  };
  for (const t of raw) {
    if (tasks.length >= maxTasks) {
      warnings.push("MAX_TASKS_TRUNCATED");
      break;
    }
    const key = String(t.task_key ?? "");
    if (!/^T\d+$/.test(key) || seen.has(key)) {
      warnings.push(`DROP_INVALID_TASK_KEY:${key || "?"}`);
      continue;
    }
    const caps = Array.isArray(t.required_capabilities)
      ? t.required_capabilities.map((c) => String(c)).filter((c) => capSet.has(c))
      : [];
    if (!caps.length) {
      warnings.push(`DROP_NO_ALLOWED_CAPS:${key}`);
      continue;
    }
    // The capability set must be jointly servable by a single executor —
    // routing picks one executor per task; an unservable combo is dead work.
    if (
      capabilitySets?.length &&
      !capabilitySets.some((set) => caps.every((c) => set.includes(c)))
    ) {
      warnings.push(`DROP_UNSERVABLE_CAPS:${key}`);
      continue;
    }
    let instruction = String(t.task_instruction ?? "").slice(0, LLM_PLANNER_MAX_INSTRUCTION);
    if (!instruction.trim()) {
      warnings.push(`DROP_EMPTY_INSTRUCTION:${key}`);
      continue;
    }
    // F2 §20 — remote tasks are no longer unconditional leaves: a
    // dependent may consume remote output ONLY through an explicitly
    // declared artifact edge (a consume name the remote dep produces).
    // TELEGRAM_DELIVERY remains exempt (it consumes result text via
    // dependency_outputs, not remote files). A remote dep with no
    // declared edge stays rejected — plan-dataflow re-verifies the same
    // rule authoritatively against the committed plan.
    const isTelegramDelivery = caps.includes("TELEGRAM_DELIVERY");
    const deps = Array.isArray(t.depends_on)
      ? [...new Set(t.depends_on.map((d) => String(d)).filter((d) => seen.has(d)))]
      : [];
    const metadata =
      t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata)
        ? (t.metadata as Record<string, unknown>)
        : {};
    // Coverage hints: `pair_coverage` is OPTIONAL model evidence, never a
    // mandate (planner-contract simplification — PAIR derives coverage
    // existentially at the gate). Top-level `pair_coverage` is the
    // model-facing field; a legacy HTTP `metadata.pair_coverage` is
    // honored only when the top-level field is absent — both present and
    // different is a deterministic conflict, and the task is dropped
    // rather than silently resolved. Normalization keeps only canonical
    // requirement-id grammar (OBL_/DEL_/CON_/PRO_/DDL_### — claimability
    // is adjudicated at the coverage gate, never here), dedupes in
    // stable order, bounds to 32, and stores the hint canonically at
    // `metadata.pair_coverage`.
    const topCoverage = t.pair_coverage;
    const metaCoverage = metadata.pair_coverage;
    if (
      topCoverage !== undefined &&
      metaCoverage !== undefined &&
      JSON.stringify(topCoverage) !== JSON.stringify(metaCoverage)
    ) {
      warnings.push(`DROP_COVERAGE_CONFLICT:${key}`);
      continue;
    }
    const rawCoverage = topCoverage !== undefined ? topCoverage : metaCoverage;
    if (rawCoverage !== undefined) {
      if (!Array.isArray(rawCoverage) || rawCoverage.length > 32) {
        // Malformed field — strip it; the field is a hint, so the task
        // survives and PAIR's own coverage derivation decides.
        warnings.push(`DROP_MALFORMED_COVERAGE:${key}`);
        delete metadata.pair_coverage;
      } else {
        const ids: string[] = [];
        for (const e of rawCoverage) {
          if (typeof e !== "string" || !/^(?:OBL|DEL|CON|PRO|DDL)_\d{3}$/.test(e)) {
            continue;
          }
          if (!ids.includes(e)) ids.push(e);
        }
        metadata.pair_coverage = ids;
      }
    }
    // R1/R2 — the optional advisory network/source requirement
    // (canonical semantics per network-requirement.ts). Top-level
    // `network_requirement` wins; `metadata.network_requirement` is
    // honored only when top-level is absent. A conflict or malformed
    // field is never silently dropped: the task survives carrying a
    // reserved `network_requirement_error` marker so the canonical gate
    // can still read the defect (it no longer rejects on it — under the
    // simplified planner contract the field is advisory evidence only,
    // and PAIR derives authority itself) — nothing here decides NETWORK
    // authority (the canonicalizer + repair do).
    const topNetReq = t.network_requirement;
    const metaNetReq = metadata.network_requirement;
    if (
      topNetReq !== undefined &&
      metaNetReq !== undefined &&
      JSON.stringify(topNetReq) !== JSON.stringify(metaNetReq)
    ) {
      warnings.push(`NETWORK_REQ_CONFLICT:${key}`);
      metadata[NETWORK_REQUIREMENT_ERROR_KEY] = "CONFLICT";
      delete metadata.network_requirement;
    }
    const rawNetReq = topNetReq !== undefined ? topNetReq : metaNetReq;
    if (rawNetReq !== undefined && metadata[NETWORK_REQUIREMENT_ERROR_KEY] === undefined) {
      const parsed = parseNetworkRequirementShape(rawNetReq);
      if (!parsed.ok) {
        warnings.push(`MALFORMED_NETWORK_REQ:${key}`);
        metadata[NETWORK_REQUIREMENT_ERROR_KEY] = "MALFORMED";
        delete metadata.network_requirement;
      } else {
        metadata.network_requirement = parsed.req;
      }
    }
    if (!isTelegramDelivery) {
      const taskShape = {
        task_key: key,
        task_instruction: instruction,
        required_capabilities: caps,
        metadata,
      };
      const cand = candidateTaskDataflow(taskShape);
      const depProducesOf = (d: string) =>
        candidateTaskDataflow(rawByKey.get(d) ?? {}).produces;
      const offending = deps.filter((d) => {
        if (!remoteKeys.has(d)) return false;
        return !cand.consumes.some((c) => depProducesOf(d).includes(c));
      });
      if (offending.length) {
        // P-GRAMMAR2 §2 — bounded unambiguous repair only: exactly ONE
        // offending remote producer emitting exactly ONE artifact, and
        // every consume edge the consumer already declared binds a real
        // produce of one of its deps (a consumer naming an artifact NO
        // dep produces is incoherent — never widen or guess). The repair
        // is a canonical instruction suffix naming the artifact as an
        // input; extraction must then prove the edge real — nothing is
        // bypassed or annotated around the gate.
        const depProduces = depProducesOf(offending[0] ?? "");
        const edgesAllReal = cand.consumes.every((c) =>
          deps.some((d) => depProducesOf(d).includes(c)),
        );
        const suffix =
          depProduces.length === 1
            ? ` Input artifact to read: ${depProduces[0]}.`
            : "";
        let repaired = false;
        if (
          offending.length === 1 &&
          depProduces.length === 1 &&
          edgesAllReal &&
          suffix.length > 0 &&
          instruction.length + suffix.length <= LLM_PLANNER_MAX_INSTRUCTION
        ) {
          const repairedInstruction = instruction + suffix;
          const recand = candidateTaskDataflow({
            ...taskShape,
            task_instruction: repairedInstruction,
          });
          if (recand.consumes.includes(depProduces[0] as string)) {
            instruction = repairedInstruction;
            warnings.push(`REPAIRED_REMOTE_DEPENDENT_EDGE:${key}`);
            repaired = true;
          }
        }
        if (!repaired) {
          warnings.push(`DROP_REMOTE_DEPENDENT:${key}`);
          continue;
        }
      }
    }
    if (Array.isArray(t.depends_on) && deps.length !== new Set(t.depends_on.map((d) => String(d))).size) {
      warnings.push(`DEP_FORWARD_OR_UNKNOWN_PRUNED:${key}`);
    }
    if (caps.some((c) => REMOTE_CAPS.has(c))) remoteKeys.add(key);
    seen.add(key);
    tasks.push({
      task_key: key,
      title: String(t.title ?? key).slice(0, 200),
      task_instruction: instruction,
      required_capabilities: caps.sort(),
      depends_on: deps,
      metadata,
    });
  }
  return { tasks, warnings };
}

/** Deterministic bounded repair: PAIR — not the planner — owns the
 *  NETWORK_ACCESS binding. A task PAIR derives as network-requiring
 *  (resolveFreshTaskNetworkAuthority → REQUIRED: a fetch-shaped
 *  instruction or an instruction naming a goal-authorized host —
 *  always operator-authorized, never annotation-derived) gets the
 *  capability added BEFORE the canonical network gates evaluate — the
 *  plan never dies on a model annotation omission or a missing/wrong
 *  structured field. Eligibility requires ALL of:
 *  (a) the fresh authority verdict is REQUIRED (same shared verdict the
 *      canonical gate consumes);
 *  (b) NETWORK_ACCESS is in the planner's allowed vocabulary;
 *  (c) the repaired capability set stays jointly servable by ≥1 supplied
 *      executor capability set — executor POLICY decides availability,
 *      never the planner's text; unservable stays unbound and the
 *      canonical gate fails it closed.
 *  A planner NETWORK_ACCESS claim on a task PAIR derives as
 *  NOT_REQUIRED is advisory routing metadata — never an authority
 *  grant and never a rejection reason (the claim merely routes to an
 *  executor whose own policy holds network).
 *  Emits `REPAIRED_NETWORK_CAPABILITY:<task_key>` warnings; shared by
 *  llmPlan and codexPlannerPlan — ONE implementation, no per-transport
 *  variants. */
export function repairNetworkCapabilityBinding(
  tasks: Array<Record<string, unknown>>,
  opts: {
    /** R1 — the provenance-bound operator goal (authority text), never
     *  the enriched envelope: hosts/network demand mint from it only. */
    goal: string;
    allowedCapabilities: string[];
    capabilitySets?: string[][];
  },
): { tasks: Array<Record<string, unknown>>; warnings: string[] } {
  const warnings: string[] = [];
  if (!opts.allowedCapabilities.includes("NETWORK_ACCESS")) return { tasks, warnings };
  // Servability must be PROVEN against a supplied executor set — when no
  // capabilitySets were supplied there is nothing to prove it against.
  if (!opts.capabilitySets?.length) return { tasks, warnings };
  const goalHosts = extractGoalHosts(opts.goal);
  const goalRequiresExternal = goalRequiresCurrentExternalData(opts.goal);
  const goalHasSubject =
    externalSubjectKeys(opts.goal).size > 0 ||
    subjectAnchors(opts.goal).size > 0;
  const out = tasks.map((t) => {
    const caps = Array.isArray(t.required_capabilities)
      ? t.required_capabilities.map((c) => String(c))
      : [];
    if (caps.includes("NETWORK_ACCESS")) return t;
    const md = (t.metadata ?? {}) as Record<string, unknown>;
    const instr = String(t.task_instruction ?? "");
    const res = resolveFreshTaskNetworkAuthority({
      req: (md.network_requirement ?? null) as NetworkRequirement | null,
      state: networkRequirementFieldState(t),
      goalHosts,
      instructionRequiresNetwork: taskRequiresNetworkAccess(instr),
      goalRequiresExternalData: goalRequiresExternal,
      instructionMatchesGoalSubject:
        goalHasSubject && instructionSatisfiesGoalSubject(instr, opts.goal),
      instruction: instr,
    });
    // INVALID is left untouched for the canonical gate's typed reject;
    // NOT_REQUIRED needs no binding.
    if (res.verdict !== "REQUIRED") return t;
    const repaired = [...new Set([...caps, "NETWORK_ACCESS"])].sort();
    if (!opts.capabilitySets!.some((set) => repaired.every((c) => set.includes(c)))) {
      return t;
    }
    warnings.push(`REPAIRED_NETWORK_CAPABILITY:${String(t.task_key ?? "")}`);
    return { ...t, required_capabilities: repaired };
  });
  return { tasks: out, warnings };
}

const SYSTEM_PROMPT = `You are the PAIR OS mission planner. Convert the operator's mission goal into a JSON task DAG.

Output ONLY a JSON object: {"tasks": [...]}. Each task is a WORK task — work that serves the goal directly:
- "task_key": "T1", "T2", ... sequential
- "title": short label
- "task_instruction": self-contained instruction for an autonomous executor agent. It must name the REAL WORK the operator asked for — carry the goal's subject matter verbatim into the instruction (e.g. goal "phân tích giá vàng hôm nay" → instruction "analyze today's gold price using ICT concepts — market structure, liquidity, order blocks — and write findings to analysis.txt"). NEVER emit meta-instructions like "analyze the goal" or "summarize the mission". Mention workspace-relative file paths when files must be read/written (e.g. "read mission_goal.txt", "write result to out.txt"). The executor runs inside the mission workspace.
- "required_capabilities": subset of the ALLOWED_CAPABILITIES list — pick the minimum needed. The router maps capabilities to executors; you never name an executor.
- Do NOT emit "network_requirement" — PAIR derives each task's network requirement itself from the instruction and the goal, and binds NETWORK_ACCESS itself; the emission schema does not carry the field and it is never authority. PAIR and runtime policy decide the actual network permission.
- EXTERNAL SOURCE CHOICE: a task instruction may name a hostname or URL ONLY when the goal literally names that host (subdomains of a goal-named host are fine) — then tasks must use exactly that source, never substitute a different site. When the goal asks for current/external research WITHOUT naming a host, keep the instruction host-free — say "fetch from the internet", "research public online sources" or "tra cứu các nguồn công khai trên Internet"; never invent a hostname/URL (github.com, tradingview.com, mql5.com, ...) to make the instruction more specific — the executor picks real sources at runtime. A repo reference like "owner/repo" is NOT a hostname — preserve the repo reference verbatim as the goal wrote it, never expand it into a URL. An instruction-named host the goal did not literally authorize fails canonical validation; PAIR and runtime policy still decide actual network permission.
- "depends_on": earlier task_keys only (DAG, acyclic). MUST list every task whose output this task needs: if it reads/copies/delivers a file another task writes, or uses its returned result, the producer goes in depends_on. Undeclared inputs make the task run before its data exists. Independent tasks stay parallel — only real producers are dependencies.

Rules:
- Emit ONLY genuine work tasks. PAIR injects its own bookkeeping task (recording the goal) before the plan is committed — NEVER emit a task whose purpose is recording the goal, and NEVER request AUTOMATON_TASK_EXECUTION (it is reserved for PAIR's injected bookkeeping task).
- 1 to WORK_TASKS work tasks. Every task must exist for at least one concrete reason: a distinct deliverable/output, a distinct capability boundary, independently parallelizable work, a verification/review boundary, or a side-effect boundary. Do NOT split trivial sequential prose work into microtasks. Prefer analysis/reasoning steps (REASONING) for thinking work, CODE_GENERATION/PYTHON_EXECUTION for code, SHELL_EXECUTION for running things, FILE_OPERATIONS for pure file writes.
- CURRENT/EXTERNAL DATA: if the goal needs current/external information (words like "hôm nay", "hiện tại", "giá", "tin tức", "mới nhất", "today", "current", "latest", "news", "price"), the data-gathering task's instruction MUST say to fetch/collect it and carry the goal's subject verbatim — PAIR derives the network requirement and binds NETWORK_ACCESS itself from the instruction wording (a required_capabilities claim is a hint, never the decision). Source naming follows EXTERNAL SOURCE CHOICE above: host-free unless the goal literally named a host. Instruct the task to RETURN the full findings as its final result text, and name produced files explicitly when a downstream task must read them.
- SOFTWARE WORK: when the goal asks to build or fix software (xây/build/create a website/app/tool/bot/script, viết code, fix bug, deploy), pick the minimum capability set the job requires (CODE_GENERATION, CODE_EDITING, SHELL_EXECUTION, PYTHON_EXECUTION, FILE_OPERATIONS). You describe the work — the router decides which executor satisfies the set.
- REMOTE DATAFLOW CONTRACT: tasks carrying REMOTE_CLOUD_TASK_EXECUTION / AUTONOMOUS_CODE_EXECUTION may execute remotely — their result text comes back, and their uploaded files land as canonical artifacts. A downstream task may depend on a remote task ONLY when it explicitly declares the produced artifact as an input (read the file it produces — name the artifact in its instruction or worker_spec); a remote dep with no declared artifact edge is rejected. TELEGRAM_DELIVERY tasks always may depend on remote tasks (they receive the remote result text through dependency_outputs).
- VISUAL DELIVERABLES: a chart computed from data the plan already produces is ordinary compute work (e.g. PYTHON_EXECUTION); a screenshot of a live website needs a task that includes NETWORK_ACCESS; a generated image is only possible when a governed image-generation capability exists in ALLOWED_CAPABILITIES. If a visual file is produced by a task that may execute remotely, it must be uploaded via the outbox endpoint described in that task's prompt — a file left on a remote machine is unusable. Followed by a TELEGRAM_DELIVERY task when the goal also asks to send it to the operator.
- TELEGRAM_DELIVERY (when ALLOWED): ONLY when the goal EXPLICITLY asks to send/deliver named output to Telegram (gửi tele/telegram, báo qua telegram, send/deliver to telegram) — never add it for a goal that merely mentions a file, an outbox, or completion. Add it as a DAG-leaf task with capability TELEGRAM_DELIVERY, depending ONLY on the tasks that produce what the goal asked to be sent. PAIR pins the delivery manifest, the canonical output language, and the final delivery instruction from the operator request — the plan does not choose what may be sent, in which language, or how. Instruction placeholder: "Stage the manifested artifacts into outbox/ unchanged, then reply DONE." (PAIR rewrites it canonically.)
- FILE DELIVERABLES: when the goal names a file to create AND asks to send it (e.g. "tạo file X.md ... gửi telegram"), the producing task must write the file directly into outbox/<exact filename> — not the workspace root — so the delivery pipeline picks it up.
- GOAL-NAMED FILE DELIVERABLES: when the goal names a file as an output/deliverable (a produce directive — create/write/produce/generate/save/export/render; tạo/viết/soạn/lưu/xuất — e.g. "create report.md", "viết notes.md"), some task must produce that exact filename as a canonical artifact — declare it with a produce verb in the instruction or worker_spec (a remote task produces files ONLY by uploading them via the outbox endpoint described in its prompt). Merely editing/modifying/fixing a source or repository file named in the goal does NOT by itself make it a standalone deliverable — do not fabricate an artifact requirement or an outbox upload for it. Remote artifact production still applies whenever the file is a real produced deliverable or a downstream task or governed delivery needs its bytes. A goal-named deliverable no task produces fails canonical validation.
- ONE PATH PER ARTIFACT: every file a task reads or writes is named by ONE consistent path form across the whole plan — a file bound for delivery is outbox/<name> everywhere. Never restate the same file under a different path form or verb ("report.md" vs "outbox/report.md", "tổng hợp thành report.md" vs "viết outbox/report.md"): every path+verb pair mints a dataflow edge, and a consume edge with no earlier producer fails canonical validation.
- BYTE DEPENDENCIES: "needs the data from T2" is NOT an input — bytes are. When a task needs another task's FILE output, the PRODUCER's instruction must name the exact artifact path it writes (e.g. "write findings to report.txt") and the CONSUMER's instruction must name that same path as its input (e.g. "read report.txt") — identical names, producer earlier, consumer depends_on the producer. A consumer that only says "send the report" with no file edge consumes the producer's RESULT TEXT via dependency_outputs — valid only for local (non-remote) producers.
- REMOTE EDGE EXAMPLES: VALID — remote T2's instruction writes "outbox/review.md"; consumer T3's instruction says "Read outbox/review.md and market.json, write report.md, then reply DONE." and T3's depends_on includes T2. INVALID — T3's instruction says "Tổng hợp kết quả từ các nguồn và viết report.md": no literal artifact path → REJECTED. A non-delivery task that depends_on a remote task MUST name the produced artifact path in its read/input instruction — paraphrases like "the results", "the output", "các nguồn" never constitute an artifact edge.
- DELIVERY VERB HYGIENE: only a task carrying TELEGRAM_DELIVERY may contain an affirmative Telegram delivery directive in its instruction. A non-delivery task's instruction must never say to send/deliver/forward anything to Telegram — no "send ... to Telegram", "gửi ... qua Telegram", "để gửi ...", "forward ... to Telegram", or any purpose clause that frames its output for Telegram delivery. A producer task just produces the artifact; the delivery relationship is expressed only through depends_on and the separate TELEGRAM_DELIVERY task. A delivery directive in a non-delivery task fails canonical validation.
- Keep task instructions concrete and verifiable; end with "then reply DONE."
- No prose, no markdown — JSON only.`;

/**
 * The ONE canonical planner prompt — shared by every planner transport
 * (OpenAI-compatible HTTP and the Codex CLI planner provider, CPL-1).
 * Any drift between transports is a contract violation: all candidates
 * must answer the same prompt under the same task-shape authority.
 */
export function buildPlannerUserPrompt(
  goal: string,
  cfg: {
    allowedCapabilities: string[];
    capabilitySets?: string[][];
    maxTasks?: number;
    replanContext?: LlmPlannerConfig["replanContext"];
    rejectionContext?: LlmPlannerConfig["rejectionContext"];
    /** R1 — provenance-bound operator goal (defaults to `goal`). The
     *  contract + work-task budget derive from it; the MISSION GOAL
     *  block still renders `goal` verbatim so appended context stays
     *  informational. */
    authorityGoal?: string;
    /** EXTERNAL_INPUT_AWARENESS — eligible sibling-mission artifacts,
     *  same shape as LlmPlannerConfig.externalInputArtifacts. */
    externalInputArtifacts?: ReadonlyArray<{
      logical_name: string;
      source_mission_id?: string;
      source_task_id?: string;
    }>;
    /** Pre-rendered advisory planning-context block (bounded). */
    planningContextBlock?: string;
    /** Pre-rendered advisory semantic goal-interpretation block
     *  (bounded). P18.6 — same advisory-only discipline. */
    semanticIntentBlock?: string;
  },
): string {
  const authorityGoal = cfg.authorityGoal ?? goal;
  const workTasks = resolveWorkTaskBudget(authorityGoal, cfg.maxTasks);
  // PRV2-B — the planner receives the canonical Goal Contract alongside
  // the raw goal. The contract is read-only authority: the model must
  // cover it, never mutate it, never invent requirements, and never
  // downgrade quantities — PAIR verifies every requirement
  // independently and a fabricated claim fails closed.
  const contract = extractGoalContract(authorityGoal);
  const reqLines = [
    ...contract.obligations.map((r) => `${r.id} obligation: ${r.text}`),
    ...contract.deliverables.map((r) => `${r.id} deliverable: ${r.text}`),
    ...contract.constraints.map((r) => `${r.id} constraint: ${r.text}`),
    ...contract.prohibitions.map((r) => `${r.id} prohibition: ${r.text}`),
    ...(contract.deadline ? [`${contract.deadline.id} deadline: ${contract.deadline.text}`] : []),
  ];
  const contractBlock = reqLines.length
    ? `GOAL CONTRACT (canonical — you must cover it, not change it):\n` +
      reqLines.join("\n") +
      `\nEvery obligation needs ≥1 real work task performing that work; every deliverable needs a task that produces the exact named file; no task may contradict a constraint or do anything a prohibition forbids; quantities stated in the contract must be preserved verbatim. ` +
      `PAIR derives and verifies coverage itself from your tasks — an obligation a task genuinely performs passes without any claim; a claimed row a task does NOT actually perform is fabricated evidence and fails the plan closed. Do NOT emit "pair_coverage" — the emission schema does not carry it.\n`
    : "";
  return (
    `ALLOWED_CAPABILITIES: ${cfg.allowedCapabilities.sort().join(", ")}\n` +
    `WORK_TASKS: ${workTasks}\n` +
    contractBlock +
    (cfg.capabilitySets?.length
      ? `EXECUTOR_CAPABILITY_SETS (one executor can serve a task only when its set covers ALL the task's required_capabilities): ${cfg.capabilitySets.map((s) => `[${s.join(", ")}]`).join(" ")}\n`
      : "") +
    (cfg.externalInputArtifacts?.length
      ? `EXTERNAL INPUT ARTIFACTS — files already produced and ACCEPTED by ` +
        `authorized sibling work under the same objective; a task may consume ` +
        `one ONLY by its exact logical name:\n` +
        cfg.externalInputArtifacts
          .slice(0, 24)
          .map(
            (a) =>
              `- ${a.logical_name}` +
              (a.source_mission_id
                ? ` (produced by mission ${a.source_mission_id}` +
                  (a.source_task_id ? `, task ${a.source_task_id}` : "") +
                  `)`
                : ""),
          )
          .join("\n") +
        (cfg.externalInputArtifacts.length > 24
          ? `\n- … ${cfg.externalInputArtifacts.length - 24} more`
          : "") +
        `\nA task's consumes may name ONLY a file produced by an earlier task ` +
        `in this plan or listed above — never a file merely because it is a ` +
        `desired output of this mission. When several entries share a logical ` +
        `name, consuming that name binds the newest listed version with that ` +
        `exact name — a staged outbox/<name> listing binds only when no ` +
        `exact-name artifact exists.\n`
      : "") +
    (cfg.replanContext
      ? `\nREPLAN CONTEXT — this is a recovery replan after a governed failure:\n` +
        `failure_class: ${cfg.replanContext.failure_class}\n` +
        (cfg.replanContext.dependency_reason
          ? `dependency_reason: ${cfg.replanContext.dependency_reason} (the plan's artifact/dataflow shape could not be resolved at dispatch)\n`
          : "") +
        (cfg.replanContext.failed_task_key
          ? `failed_task: ${cfg.replanContext.failed_task_key}\n`
          : "") +
        `Do NOT re-emit the failed plan or a semantic equivalent (same topology, instructions, artifact edges, executor constraints, delivery behavior — plan_semantic_digest ${cfg.replanContext.failed_plan_semantic_digest ?? "n/a"}). ` +
        `Previously rejected candidate digests you must not reproduce: ${(cfg.replanContext.rejected_semantic_digests ?? []).join(", ") || "none"}.\n` +
        `Propose a genuinely different feasible plan for the SAME goal: change the artifact flow or task decomposition so the named failure cannot recur (e.g. make the needed artifact the explicit output of an earlier producer task and name the same path in the consumer's instruction). ` +
        `Preserve every unrelated constraint (capabilities allowed, DAG rules, telegram rules) and request no wider permissions than the failed plan.\n`
      : "") +
    (cfg.rejectionContext
      ? (cfg.rejectionContext.origin === "PRIOR_RUN"
          ? `\nPLAN REJECTION — a previous planning run for this same work item was rejected by PAIR for the following canonical validation defect:\n`
          : `\nPLAN REJECTION — your previous plan from this same planner candidate was rejected by PAIR for the following canonical validation defect:\n`) +
        `validation_code: ${cfg.rejectionContext.validation_code}\n` +
        `rejection_detail: ${typeof cfg.rejectionContext.detail === "string" && /^[\x20-\x7E]{1,200}$/.test(cfg.rejectionContext.detail) ? cfg.rejectionContext.detail : cfg.rejectionContext.validation_code}\n` +
        `task warnings: ${cfg.rejectionContext.task_warnings.filter((w) => /^[A-Z0-9_:.\-]+$/.test(String(w))).slice(0, 10).join(", ") || "none"}\n` +
        (cfg.rejectionContext.validation_code === "FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID"
          ? `Specific fix: remove every hostname/URL the goal does not literally authorize from the failing task's instruction — keep the task host-free rather than substituting a different host; preserve unrelated task structure, capabilities and dependencies.\n`
          : "") +
        (cfg.rejectionContext.validation_code === "FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK"
          ? `Specific fix: remove the Telegram send/delivery directive (or purpose clause) from the non-delivery task — the producer keeps only its production work; delivery intent belongs exclusively to the TELEGRAM_DELIVERY task; preserve the artifact/dependency relationship.\n`
          : "") +
        (cfg.rejectionContext.validation_code === "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT" ||
         cfg.rejectionContext.validation_code === "FAIL_CLOSED_PLAN_DATAFLOW_ORDER"
          ? `Specific fix: a task consumes an artifact with no earlier producer — use ONE consistent path per artifact, declare the producing task earlier (or consume a file listed under EXTERNAL INPUT ARTIFACTS by its exact logical name — never a desired output name), and never restate the same file under a different path form or verb; preserve the artifact/dependency relationship.\n`
          : "") +
        `Do not re-emit it unchanged. Make the minimum change necessary to fix the named defect. Preserve unrelated task structure, capabilities, dependencies, constraints and delivery intent. Request no wider authority.\n`
      : "") +
    (cfg.semanticIntentBlock ? `\n${cfg.semanticIntentBlock}` : "") +
    (cfg.planningContextBlock ? `\n${cfg.planningContextBlock}` : "") +
    `\nMISSION GOAL:\n${goal}`
  );
}


export function plannerSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export async function llmPlan(goal: string, cfg: LlmPlannerConfig): Promise<LlmPlanResult> {
  // R1 — authority derivations bind the provenance-bound operator goal;
  // the enriched mission text is context only.
  const authorityGoal = cfg.authorityGoal ?? goal;
  const maxTasks = resolveWorkTaskBudget(authorityGoal, cfg.maxTasks);
  // R1.A — sanitize keeps the PAIR-reserved AUTOMATON key ONLY so a pure
  // bookkeeping-shaped emission survives to the canonicalize seam for
  // deterministic normalization (drop + dependency remap onto injected
  // T1). It is never model-visible (ALLOWED_CAPABILITIES renders
  // cfg.allowedCapabilities verbatim) and can never survive as a work
  // task — reservedAutomatonMisuseKey above throws the candidate first.
  const sanitizeCaps = cfg.allowedCapabilities.includes("AUTOMATON_TASK_EXECUTION")
    ? cfg.allowedCapabilities
    : [...cfg.allowedCapabilities, "AUTOMATON_TASK_EXECUTION"];
  const timeoutMs = cfg.timeoutMs ?? LLM_PLANNER_DEFAULT_TIMEOUT_MS;
  const deadlineAt = cfg.deadlineMs;
  const apiKey = envGet(cfg.env, cfg.credentialEnv);
  const fetchImpl = cfg.fetchFn ?? fetch;

  // Fail closed on unusable plans: tasks=[] signals "no plan" — the caller
  // must reject submission rather than silently run the T1-only bookkeeping
  // plan, which would execute nothing yet report COMPLETED (seen live).
  const reject = (warnings: string[]): LlmPlanResult => ({
    tasks: [],
    source: "FALLBACK",
    model: cfg.model,
    warnings,
  });

  if (!apiKey) return reject(["LLM_PLANNER_NO_CREDENTIAL"]);
  if (!cfg.allowedCapabilities.length) return reject(["LLM_PLANNER_NO_CAPS"]);

  const userPrompt = buildPlannerUserPrompt(goal, cfg);

  // One attempt: fetch + parse + sanitize into a task DAG (or warnings).
  const attempt = async (): Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[]; raw_delivery_emission_count?: number; raw_delivery_emission_state?: RawDeliveryEmissionState }> => {
    let text: string;
    try {
      // AUDIT R1 F4 — counted at the initiation point: a request that
      // then fails/times out still provably reached the provider.
      if (cfg.providerCounter) cfg.providerCounter.requests += 1;
      const resp = await fetchImpl(cfg.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(
          deadlineAt != null
            ? Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()))
            : timeoutMs,
        ),
      });
      if (!resp.ok) return { tasks: [], warnings: [`LLM_PLANNER_HTTP_${resp.status}`] };
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      text = String(data.choices?.[0]?.message?.content ?? "");
    } catch (e) {
      const name = e instanceof Error ? e.name : "UNKNOWN";
      return { tasks: [], warnings: [`LLM_PLANNER_REQUEST_${name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "ERROR"}`] };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      return { tasks: [], warnings: ["LLM_PLAN_NO_JSON"] };
    }
    const rawTasks = (parsed as { tasks?: unknown })?.tasks;
    if (!Array.isArray(rawTasks) || !rawTasks.length) return { tasks: [], warnings: ["LLM_PLAN_NO_TASKS"] };
    // PRV2-A R1.A — reserved-capability misuse (AUTOMATON outside pure
    // bookkeeping shape) fails the candidate deterministically; it is
    // never stripped-and-pretended into a different request.
    // HOTFIX 1 R1 — TRUE raw emission evidence BEFORE the transport's
    // own sanitize/drop pass: a malformed TELEGRAM_DELIVERY emission
    // dropped here still counted as a planner attempt.
    const rawDeliveryEmissions = inspectRawDeliveryEmissions(rawTasks);
    const em = {
      raw_delivery_emission_count: rawDeliveryEmissions.count,
      raw_delivery_emission_state: rawDeliveryEmissions.state,
    };
    const reservedKey = reservedAutomatonMisuseKey(rawTasks as Array<Record<string, unknown>>);
    if (reservedKey) return { tasks: [], warnings: [`${LLM_PLAN_RESERVED_CAPABILITY_WARNING}:${reservedKey}`], ...em };
    const { tasks, warnings } = sanitizePlan(rawTasks as RawTask[], sanitizeCaps, maxTasks, cfg.capabilitySets);
    if (!tasks.length) return { tasks: [], warnings: ["LLM_PLAN_ALL_INVALID", ...warnings], ...em };
    // Bounded repair BEFORE the canonical network gates: a fetch-shaped task
    // missing NETWORK_ACCESS gets it added deterministically (same helper the
    // codex planner lane uses) instead of dying on the annotation omission.
    const repair = repairNetworkCapabilityBinding(tasks, {
      goal: authorityGoal,
      allowedCapabilities: cfg.allowedCapabilities,
      capabilitySets: cfg.capabilitySets,
    });
    return { tasks: repair.tasks, warnings: [...warnings, ...repair.warnings], ...em };
  };

  // Degenerate output (ZERO usable work tasks — a bookkeeping-only plan
  // performs no work) replans once, then rejects. P-REASK —
  // cfg.maxProviderRequests bounds THIS invocation's provider calls: the
  // default 2 preserves the historical INITIAL retry contract; a
  // canonical-rejection re-ask passes 1 — exactly one provider request.
  const warnings: string[] = [];
  const maxProviderRequests = Math.max(
    1,
    Math.min(2, cfg.maxProviderRequests ?? 2),
  );
  for (let i = 0; i < maxProviderRequests; i++) {
    // AUDIT R1 F3 — never START a provider request once the run deadline
    // has passed; the in-flight request's own timeout is additionally
    // min()'d against the deadline inside `attempt`.
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      warnings.push("LLM_PLANNER_RUN_DEADLINE_EXCEEDED");
      break;
    }
    const a = await attempt();
    const usable = a.tasks.filter(
      (t) => !isBookkeepingShapedTask(t, sanitizeCaps),
    );
    if (usable.length >= LLM_PLANNER_MIN_TASKS) {
      return { tasks: a.tasks, source: "LLM", model: cfg.model, warnings: [...warnings, ...a.warnings], raw_delivery_emission_count: a.raw_delivery_emission_count, raw_delivery_emission_state: a.raw_delivery_emission_state };
    }
    warnings.push(...a.warnings, "LLM_PLAN_DEGENERATE");
  }
  return reject(warnings);
}
