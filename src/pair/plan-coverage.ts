/**
 * PRV2-B — Plan coverage authority. The ONE seam that decides whether a
 * canonical plan actually covers the operator's Goal Contract before the
 * plan may pin.
 *
 * The model's optional `pair_coverage` mapping is a proposal only — PAIR
 * verifies every requirement independently, so a fabricated mapping (or
 * a missing one) can never certify coverage the tasks do not provide:
 *  - obligation covered  = a work task whose instruction is a bounded
 *    semantic match (verb class + subject identity + preserved quantity);
 *  - deliverable covered = a task that is a real producer per the
 *    existing canonical artifact/dataflow machinery (extractTaskDataflow),
 *    not a filename grep;
 *  - constraint held     = no task contradicts a bounded constraint
 *    (explicit budget ceilings are checked directly; the rest are
 *    PRESERVED, never claimed PROVEN when unverifiable);
 *  - prohibition held    = no task instruction invokes the prohibited
 *    term and no task claims the prohibited capability;
 *  - bookkeeping (AUTOMATON_TASK_EXECUTION) can never count as coverage.
 *
 * Fail-closed codes:
 *  FAIL_CLOSED_PLAN_INCOMPLETE            — a mandatory requirement has
 *                                           no genuine covering task.
 *  FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION  — a task provably contradicts
 *                                           a constraint or prohibition.
 * Both are IntegrityErrors thrown at the canonical seam → the candidate
 * attempt settles FAILED/PLAN_INVALID and planner failover proceeds.
 */

import { IntegrityError } from "./errors.js";
import { artifactNamesEquivalent } from "./artifact-authority.js";
import { extractTaskDataflow } from "./plan-dataflow.js";
import { externalSubjectKeys, subjectAnchors } from "./llm-planner.js";
import {
  PROHIBITION_ACTION_CLASSES,
  type GoalContract,
  type GoalRequirement,
} from "./goal-contract.js";

export type CoverageState = "PROVEN" | "PRESERVED" | "UNVERIFIABLE" | "VIOLATED";

export interface CoverageRow {
  requirement_id: string;
  kind: GoalRequirement["kind"];
  state: CoverageState;
  task_keys: string[];
}

export interface PlanCoverageReport {
  contractDigest: string;
  verdict: "PASS";
  rows: CoverageRow[];
}

/* ------------------------------------------------------------------ */
/* bounded correspondence                                              */
/* ------------------------------------------------------------------ */

/** Verb classes shared by obligation text and task instruction. A task
 *  must perform work of the same class as the obligation it covers. */
const VERB_CLASSES: Array<{ cls: string; re: RegExp }> = [
  { cls: "research", re: /\b(?:research|study|studies|investigat|survey|search|find|browse|gather|collect|nghiên cứu|khảo sát|thu thập|tìm)/iu },
  { cls: "analyze", re: /\b(?:analy[sz]e|analys|assess|evaluat|review|phân tích|đánh giá|xem xét)/iu },
  { cls: "compare", re: /\b(?:compar|benchmark|contrast|so sánh|đối chiếu)/iu },
  { cls: "propose", re: /\b(?:propos|recommend|suggest|deriv|identify|đề xuất|xác định)/iu },
  { cls: "fetch", re: /\b(?:fetch|retriev|get|pull|download|scrape|extract|search|find|browse|gather|collect|lấy|tải|thu thập|tra cứu|tìm)/iu },
  { cls: "create", re: /\b(?:creat|writ|build|develop|design|implement|produc|generat|draft|save|export|render|tạo|viết|soạn|lưu|xuất|xây|phát triển|thiết kế|triển khai)/iu },
  { cls: "compute", re: /\b(?:comput|calcul|measure|quantif|estimat|forecast|tính|ước tính|dự báo)/iu },
  { cls: "plot", re: /\b(?:plot|draw|chart|graph|vẽ|biểu đồ)/iu },
  { cls: "summarize", re: /\b(?:summar|digest|tóm tắt)/iu },
  { cls: "test", re: /\b(?:test|verif|validat|check|kiểm tra|kiểm)/iu },
  { cls: "monitor", re: /\b(?:monitor|track|watch|theo dõi|giám sát)/iu },
  { cls: "translate", re: /\b(?:translat|dịch)/iu },
  { cls: "deploy", re: /\b(?:deploy|publish|xuất bản)/iu },
  { cls: "list", re: /\b(?:list|rank|score|select|choose|screen|liệt kê|xếp hạng|chọn)/iu },
  /* Semantic Planning V1 (D′) — outcome verbs: pursuing a measured
   *  result ("grow subscribers", "đạt 1.000 người đăng ký", "attract
   *  leads"). Distinct from preparation classes so a research-only task
   *  can never claim to satisfy an outcome obligation. */
  { cls: "outcome", re: /\b(?:grow|growth|grows|grew|grown|growing|increas|boost|gain|achiev|reach|attain|acquir|attract|earn|expand|scal|improv|rais|driv|convert|recruit|onboard|tăng trưởng|tăng|gia tăng|đạt được|đạt|thu hút|mở rộng|nâng cao|nâng|cải thiện|thúc đẩy|chuyển đổi|tuyển dụng|tuyển)/iu },
  /* Fulfillment verbs — direct goal-pursuing work that is neither pure
   *  preparation nor the outcome verb itself: executing, delivering,
   *  operating the thing that produces the outcome. */
  { cls: "fulfill", re: /\b(?:execut|operat|deliver|run|launch|perform|conduct|carry out|roll out|triển khai|thực hiện|thực thi|vận hành|chạy|phát hành|phát sóng|đăng tải|đăng)/iu },
];

function verbClasses(text: string): Set<string> {
  const s = new Set<string>();
  for (const { cls, re } of VERB_CLASSES) if (re.test(text)) s.add(cls);
  return s;
}

/** Tokens that carry no subject content — verbs, function words,
 *  recency/quantity modifiers — excluded from content-token overlap. */
const CONTENT_TOKEN_STOP = new Set([
  "research", "study", "studies", "investigate", "survey", "analyse",
  "analyze", "analyses", "assess", "evaluate", "review", "compare",
  "comparing", "benchmark", "contrast", "propose",
  "recommend", "suggest", "derive", "identify", "fetch", "retrieve",
  "collect", "gather", "download", "scrape", "extract", "create",
  "write", "build", "develop", "design", "implement", "produce",
  "generate", "draft", "save", "export", "render", "compute",
  "calculate", "measure", "quantify", "estimate", "forecast", "plot",
  "draw", "summarize", "digest", "test", "verify",
  "validate", "check", "monitor", "track", "translate", "deploy",
  "publish", "list", "rank", "score", "select", "choose", "screen",
  "get", "pull", "return", "read", "send", "stage", "then",
  "reply", "done", "use", "using", "search", "find", "browse",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at",
  "for", "from", "with", "by", "as", "is", "are", "be", "it",
  "its", "this", "that", "these", "those", "you", "your", "we",
  "our", "they", "their", "if", "than", "so", "such", "all",
  "any", "each", "every", "no", "not", "only", "same", "own",
  "over", "per", "via", "vs", "based", "into", "about",
  "current", "currently", "latest", "newest", "new", "live",
  "recent", "online", "today", "now", "real", "time", "top",
  "best", "least", "most", "min", "max", "minimum", "maximum",
  "fewer", "up", "down", "out",
]);

/** Vietnamese action/verb tokens (bounded — mirrors the VI alternations
 *  already declared in VERB_CLASSES): the action itself is never subject
 *  evidence, so "tóm tắt thời tiết" can never cover "tóm tắt mục đích
 *  dự án" by sharing "tóm". Kept to unambiguous action lexemes ≥3 chars —
 *  noun-shaped tokens (`giá`, `báo`, `bản`, `hạng`, `tính`, `đồ`) stay
 *  OUT: they carry subject identity and the subject-class map already
 *  routes them. */
const CONTENT_TOKEN_VI_ACTION_STOP = new Set([
  "tóm", "tắt", // tóm tắt — summarize
  "phân", "tích", // phân tích — analyze
  "nghiên", "cứu", // nghiên cứu — research
  "khảo", "sát", // khảo sát — survey
  "thu", "thập", // thu thập — collect
  "tìm", "tra", "lấy", "tải", "cào", // find/lookup/get/download/scrape
  "xem", "xét", "đánh", // xem xét / đánh giá — review/assess
  "sánh", "đối", "chiếu", // so sánh / đối chiếu — compare
  "xuất", "xác", "định", // đề xuất / xác định — propose/identify
  "tạo", "viết", "soạn", "lưu", "xây", "dựng", // create/write/draft/save/build
  "phát", "triển", "thiết", // phát triển / thiết kế — develop/design
  "ước", // ước tính — estimate
  "vẽ", "biểu", // vẽ / biểu đồ — plot/chart
  "kiểm", "theo", "dõi", "giám", // kiểm tra / theo dõi / giám sát — test/monitor
  "dịch", "liệt", "xếp", "chọn", // dịch / liệt kê / xếp hạng / chọn — translate/list/rank/select
  "đọc", "ghi", "gửi", "xóa", "sửa", // read/write/send/delete/modify
]);

/** Content-bearing tokens of a requirement clause — the subject words
 *  a covering task must share when no identity anchor exists. Unicode
 *  letters are the token charset: diacritics-bearing text (Vietnamese
 *  obligations like `tóm tắt mục đích dự án`) otherwise shatters into
 *  sub-3 fragments and can never produce evidence. */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (
      w.length < 3 ||
      /^\d+$/.test(w) ||
      CONTENT_TOKEN_STOP.has(w) ||
      CONTENT_TOKEN_VI_ACTION_STOP.has(w)
    ) continue;
    out.add(w);
  }
  return out;
}

function sharesContentToken(reqText: string, taskText: string): boolean {
  const req = contentTokens(reqText);
  if (!req.size) return false;
  const task = new Set<string>();
  for (const m of taskText.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    task.add(w);
    if (w.endsWith("s")) task.add(w.slice(0, -1));
  }
  for (const w of req) {
    if (task.has(w) || (w.endsWith("s") && task.has(w.slice(0, -1)))) return true;
  }
  return false;
}

function taskIsBookkeeping(t: Record<string, unknown>): boolean {
  const caps = (t.required_capabilities as string[] | undefined) ?? [];
  return caps.includes("AUTOMATON_TASK_EXECUTION");
}

function taskKeys(tasks: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const t of tasks) m.set(String(t.task_key ?? ""), t);
  return m;
}

/** Bounded semantic correspondence between an obligation clause and a
 *  task instruction: same verb class, the obligation's subject identity
 *  anchors are all bound, subject classes preserved when no anchors
 *  exist, and any stated quantity is preserved (never downgraded). */
/** Preparation-only verb classes — a task whose work is ENTIRELY one of
 *  these is groundwork, never goal fulfillment (Semantic Planning V1
 *  D2): "research growth strategies" prepares for "grow subscribers"
 *  but does not perform it. */
const PREPARATION_ONLY = new Set([
  "research", "analyze", "compare", "propose", "fetch", "summarize",
  "list",
]);

function isPreparationOnly(taskVerbs: Set<string>): boolean {
  if (!taskVerbs.size) return false;
  for (const v of taskVerbs) if (!PREPARATION_ONLY.has(v)) return false;
  return true;
}

/** Extract every quantity mention from task text — including
 *  thousands-grouped forms ("1,000" EN / "1.000" VI) so a stated floor
 *  of 1,000 is preserved against grouped task text and a bare "1" can
 *  never satisfy it. */
function quantityNums(text: string): number[] {
  const out: number[] = [];
  const re = /\b(\d{1,3}(?:[.,]\d{3})+|\d{1,9})\b/g;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    out.push(raw.includes(",") || raw.includes(".")
      ? Number(raw.replace(/[.,]/g, ""))
      : Number(raw));
  }
  return out;
}

function taskCoversObligation(instr: string, req: GoalRequirement): boolean {
  const t = instr.trim();
  if (!t) return false;
  const reqVerbs = verbClasses(req.text);
  const taskVerbs = verbClasses(t);
  // The task must perform at least one verb class the requirement
  // asked. Exception (Semantic Planning V1): an OUTCOME obligation is
  // covered by fulfillment — the task needn't restate the outcome verb
  // ("execute the growth campaign" covers "grow subscribers") — but a
  // preparation-only task never does.
  if (reqVerbs.size && ![...reqVerbs].some((v) => taskVerbs.has(v))) {
    const outcomeReq = reqVerbs.has("outcome");
    if (!outcomeReq) return false;
    if (!taskVerbs.has("outcome") && !taskVerbs.has("fulfill")) return false;
  }
  // Semantic Planning V1 (D2) — outcome obligations demand fulfillment
  // evidence: a task whose verbs are ALL preparation-class can never
  // satisfy "grow / increase / achieve", however topical it is.
  if (reqVerbs.has("outcome") && isPreparationOnly(taskVerbs)) {
    return false;
  }
  const reqAnchors = subjectAnchors(req.text);
  const taskAnchors = subjectAnchors(t);
  // Subject identity: every anchor in the requirement must appear in the
  // task (generic modifiers are never anchors — PRV2-A R7 semantics).
  for (const a of reqAnchors) {
    if (!taskAnchors.has(a)) return false;
  }
  // Subject class preservation when the obligation has no identity
  // anchor: at least one shared subject-class key is required so a
  // task about an unrelated subject cannot claim coverage.
  const reqKeys = externalSubjectKeys(req.text);
  if (!reqAnchors.size) {
    // No identity anchor: subject-class overlap OR a shared content
    // token is required — a shared verb alone ("the comparison") can
    // never prove the task performs THIS obligation's work. Exception:
    // a verb-only obligation names no subject at all — every token is an
    // action lexeme or below the token floor, so no subject evidence can
    // ever exist; demanding it makes the obligation un-coverable (dead
    // obligation → PLAN_INCOMPLETE). When the requirement carries no
    // subject evidence AND it did exercise a verb class (checked above),
    // the same-class verb in the task is sufficient evidence.
    const subjectEvidence = reqKeys.size > 0 || contentTokens(req.text).size > 0;
    if (subjectEvidence || !reqVerbs.size) {
      const taskKeysSet = externalSubjectKeys(t);
      const keyOverlap = [...reqKeys].some((k) => taskKeysSet.has(k));
      if (!keyOverlap && !sharesContentToken(req.text, t)) return false;
    }
  }
  // Quantity preservation: a stated floor must appear in the task at
  // the same or a larger magnitude — "20" can never become "5", and
  // "1,000" / VI "1.000" count at their true magnitude, never as "1".
  if (req.quantity?.min !== undefined) {
    const nums = quantityNums(t);
    if (!nums.length || Math.max(...nums) < req.quantity.min) return false;
  }
  return true;
}

/** A task covers a deliverable only when the canonical artifact/dataflow
 *  machinery proves it produces the named file — declared produces,
 *  produce-verb instruction extraction, or the delivery manifest —
 *  never by filename grep alone. Name matching goes through the ONE
 *  canonical equivalence authority `artifactNamesEquivalent` (DSN-1):
 *  exact identity or the `outbox/<basename>` staging alias — never a
 *  two-sided basename guess (`dirA/x ≡ dirB/x` is not equivalent). */
function taskProducesDeliverable(task: Record<string, unknown>, name: string): boolean {
  try {
    const df = extractTaskDataflow(task);
    return df.produces.some((p) => artifactNamesEquivalent(p, name));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* constraints + prohibitions                                          */
/* ------------------------------------------------------------------ */

/** Checkable task amounts — common explicit forms of the SAME unit the
 *  constraint states (`$50` ≡ `50 USD` ≡ `USD 50`; no conversion). */
const TASK_AMOUNT_RES = [
  /\$\s*(\d+(?:\.\d+)?)/g,
  /\b(\d+(?:\.\d+)?)\s*usd\b/gi,
  /\busd\s*(\d+(?:\.\d+)?)/gi,
];
const TELEGRAM_PROHIBITED_TERMS = new Set(["telegram", "tele", "bot"]);

/* ------------------------------------------------------------------ */
/* prohibition enforcement — action-gated, object-scoped                */
/* ------------------------------------------------------------------ */

/** A prohibited term matches only as a whole token — "cap" inside
 *  "capacity" or "cat" inside "concatenate" is never evidence. */
function termHit(instr: string, term: string): boolean {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return re.test(instr);
}

/** Negation markers bounded to ≤2 word tokens before the verb —
 *  "avoid using" / "không sử dụng" declares compliance, never performs
 *  the act. R1 — scope is strict: only whitespace separates tokens, so
 *  any punctuation breaks it, and clause connectives (then/but/however/
 *  sau đó/nhưng/và/and/or/hoặc) are breakers — "do not analyze first,
 *  then use martingale" never suppresses the real `use`. On ambiguity
 *  the match stays live — suppression can never fail-open. */
const NEGATION_WINDOW_RE =
  /(?:not|n't|never|no|non|without|avoid(?:ing)?|instead\s+of|rather\s+than|không|chẳng|chưa|tránh|đừng|thay\s+vì|miễn|cấm|ngoài)\s+(?:(?!(?:then|but|however|nevertheless|sau|nhưng|rồi|và|and|or|hoặc)(?=\s|$))[\p{L}\p{N}_-]+\s+){0,2}$/iu;

/* ------------------------------------------------------------------ */
/* R2 — segment-local action↔object association                         */
/* ------------------------------------------------------------------ */

/** Task instructions split into scope segments on punctuation and on
 *  clause-shifting connectives (then/but/however/nevertheless/
 *  sau đó/sau khi/rồi/nhưng). `and`/`và`/`or`/`hoặc` are deliberately
 *  NOT breakers — they join an action's object list ("use grid and
 *  martingale" is ONE `use` scope), so treating them as boundaries
 *  would fail open. */
const INSTR_SEGMENT_RE =
  /[,;!?;:—–…]|\.(?![\p{L}\p{N}])|\s+(?:then|but|however|nevertheless|sau\s+đó|sau\s+khi|rồi|nhưng)\s+/giu;

function instructionSegments(instr: string): Array<[number, number]> {
  const segs: Array<[number, number]> = [];
  let last = 0;
  INSTR_SEGMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INSTR_SEGMENT_RE.exec(instr)) !== null) {
    segs.push([last, m.index]);
    last = m.index + m[0].length;
  }
  segs.push([last, instr.length]);
  return segs;
}

/** Every boundary match of a prohibited term with its position. */
function termMatchSpans(
  instr: string,
  term: string,
): Array<[number, number]> {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const out: Array<[number, number]> = [];
  for (const m of instr.matchAll(re)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Passive auxiliaries before the action flip the object to the
 *  LEFT of the verb: "report.md was deleted" / "report.md sẽ bị xóa".
 *  Bounded — aux + at most one intervening token, whitespace-only. */
const PASSIVE_AUX_RE =
  /(?:bị|be|been|being|is|are|was|were|get|gets|got|getting)\s+(?:[\p{L}\p{N}_-]+\s+){0,1}$/iu;

/** R3 — a structured prohibition violates only when a non-negated
 *  forbidden action AND a prohibited object term land inside the
 *  action's OWN object scope: forward from the action to the next
 *  action boundary (any class — "check X and delete Y" makes `delete`
 *  own only `Y`) or to the segment end. Connectives `and|và|or|hoặc`
 *  stay inside the scope — they join one action's object list
 *  ("delete temp and report.md" bans both). A passive hit binds the
 *  object before the verb instead (span between neighbouring actions).
 *  A ban with no object terms still forbids the class outright. */
function taskShowsProhibitedAct(
  instr: string,
  classes: Set<string>,
  terms: string[],
): { cls: string; term: string | null } | null {
  const hits: Array<{ cls: string; start: number; end: number; negated: boolean }> = [];
  for (const { cls, re } of PROHIBITION_ACTION_CLASSES) {
    const g = new RegExp(re.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = g.exec(instr)) !== null) {
      const before = instr.slice(Math.max(0, m.index - 48), m.index);
      hits.push({
        cls,
        start: m.index,
        end: m.index + m[0].length,
        negated: NEGATION_WINDOW_RE.test(before),
      });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const acts0 = hits.filter((h) => classes.has(h.cls) && !h.negated);
  if (!acts0.length) return null;
  if (!terms.length) return { cls: acts0[0].cls, term: null };
  // An action-looking token inside a prohibited filename ("write.txt"
  // under a delete ban on write.txt) is the OBJECT, not an action and
  // not a scope boundary: drop hits overlapping term spans that sit in
  // a dotted filename context (`term.ext`).
  const objectSpans: Array<[number, number]> = [];
  for (const term of terms) {
    for (const [ts, te] of termMatchSpans(instr, term)) {
      if (instr[te] === "." && /[\p{L}\p{N}]/u.test(instr[te + 1] ?? "")) {
        objectSpans.push([ts, te]);
      }
    }
  }
  const hits2 = objectSpans.length
    ? hits.filter((h) => !objectSpans.some(([s, e]) => h.start < e && h.end > s))
    : hits;
  const acts = hits2.filter((h) => classes.has(h.cls) && !h.negated);
  if (!acts.length) return null;
  const segs = instructionSegments(instr);
  for (const a of acts) {
    const seg = segs.find(([s, e]) => a.start >= s && a.start < e);
    if (!seg) continue;
    // R4 — scope boundaries must come from the SAME segment: an action
    // in a later/earlier clause never clamps this action's scope and
    // os/oe can never escape seg.
    const next = hits2.find((h) => h.start >= a.end && h.start < seg[1]);
    const prev = [...hits2]
      .reverse()
      .find((h) => h.end <= a.start && h.start >= seg[0]);
    const passive = PASSIVE_AUX_RE.test(
      instr.slice(Math.max(0, a.start - 32), a.start),
    );
    const [os, oe] = passive
      ? [prev ? prev.end : seg[0], a.start]
      : [a.end, next ? next.start : seg[1]];
    for (const term of terms) {
      for (const [ts, te] of termMatchSpans(instr, term)) {
        if (ts >= os && te <= oe) return { cls: a.cls, term };
      }
    }
  }
  return null;
}

/** Bounded channel/platform vocabulary for `only <channel>` constraints:
 *  the sibling space is enumerable here, never a free-text guess. */
const ONLY_CHANNELS = new Set([
  "telegram", "slack", "discord", "email", "sms", "whatsapp",
  "webhook", "api", "cli",
]);

/** Versioned family siblings: "mql5" admits the family `mql\d` — a task
 *  naming "mql4" provably violates an `only mql5` bound. Returns the
 *  family regex or null when the term has no enumerable siblings. */
function versionFamilyRe(term: string): RegExp | null {
  const m = /^([a-z][a-z0-9_-]{1,}?)(\d+)$/.exec(term);
  if (!m) return null;
  return new RegExp(`\\b${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+\\b`, "i");
}

/** Does the instruction carry evidence of engaging the constrained
 *  dimension at all (it names the permitted value)? */
function onlyConstraintEvidence(instr: string, term: string): boolean {
  return new RegExp(
    `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  ).test(instr);
}

/** Deterministic contradiction detection for `only X` constraints:
 *  returns the excluded sibling token the instruction invokes, or null.
 *  Unknown sibling spaces yield null (PRESERVED), never a guess. */
function violatesOnlyConstraint(instr: string, onlyTerms: string[]): string | null {
  const lc = instr.toLowerCase();
  for (const term of onlyTerms) {
    const fam = versionFamilyRe(term);
    if (fam) {
      for (const m of lc.matchAll(new RegExp(fam.source, "gi"))) {
        if (m[0] !== term.toLowerCase()) return m[0];
      }
      continue;
    }
    if (ONLY_CHANNELS.has(term)) {
      for (const ch of ONLY_CHANNELS) {
        if (ch !== term && new RegExp(`\\b${ch}\\b`, "i").test(lc)) return ch;
      }
    }
  }
  return null;
}

function instructionAmounts(instr: string): number[] {
  const out: number[] = [];
  for (const re of TASK_AMOUNT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(instr)) !== null) out.push(Number(m[1]));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the authority seam                                                  */
/* ------------------------------------------------------------------ */

/** Validate a model-proposed `pair_coverage` annotation on a task:
 *  every claimed requirement id must exist in the contract AND be a
 *  claimable kind (obligation or deliverable — CON/PRO/DDL rows are
 *  PAIR-side checks, never claimable rows) AND the task must genuinely
 *  cover it — declaration alone grants nothing. */
function validateProposedCoverage(
  task: Record<string, unknown>,
  contract: GoalContract,
  coveredBy: (task: Record<string, unknown>, req: GoalRequirement) => boolean,
): void {
  const md = (task.metadata ?? {}) as Record<string, unknown>;
  const declared = md.pair_coverage;
  if (declared === undefined) return;
  if (!Array.isArray(declared) || declared.length > 32) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_INCOMPLETE",
      `task ${String(task.task_key)} carries malformed pair_coverage`,
    );
  }
  const all = new Map<string, GoalRequirement>();
  for (const r of [
    ...contract.obligations,
    ...contract.deliverables,
    ...contract.constraints,
    ...contract.prohibitions,
  ]) all.set(r.id, r);
  for (const id of declared.map((x) => String(x))) {
    const req = all.get(id);
    if (!req || (req.kind !== "obligation" && req.kind !== "deliverable") || !coveredBy(task, req)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_INCOMPLETE",
        `task ${String(task.task_key)} claims coverage of ${id} it does not provide`,
      );
    }
  }
}

/** THE coverage authority seam — called at canonicalize time, before
 *  the plan can become the winning/pinned canonical plan. */
export function assertPlanCoverage(
  contract: GoalContract,
  tasks: Array<Record<string, unknown>>,
): PlanCoverageReport {
  const work = tasks.filter((t) => !taskIsBookkeeping(t));
  const byKey = taskKeys(tasks);
  const rows: CoverageRow[] = [];

  const covers = (task: Record<string, unknown>, req: GoalRequirement): boolean => {
    const instr = String(task.task_instruction ?? "");
    return req.kind === "obligation"
      ? taskCoversObligation(instr, req)
      : taskProducesDeliverable(task, String(req.target ?? ""));
  };

  // Validate model-proposed mappings first — a fabricated mapping is a
  // hard failure, never an authority grant.
  for (const t of work) validateProposedCoverage(t, contract, covers);

  // P-COVMAP — bookkeeping can never mint coverage: the PAIR-injected
  // bookkeeping task never carries a map, and a model-authored
  // bookkeeping-shaped emission is normalized away upstream — any
  // surviving claim on bookkeeping is fabricated.
  for (const t of tasks) {
    if (taskIsBookkeeping(t) && (t.metadata as Record<string, unknown> | undefined)?.pair_coverage !== undefined) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_INCOMPLETE",
        `task ${String(t.task_key)} claims coverage on PAIR bookkeeping`,
      );
    }
  }

  // PLANNER-CONTRACT SIMPLIFICATION — `pair_coverage` is a HINT, never a
  // mandate: a work task is no longer required to declare the map, and
  // an unclaimed row can never kill a plan by bookkeeping alone. PAIR
  // derives coverage existentially below — the same covers() evidence
  // the claim validator uses — so a task genuinely performing an
  // obligation satisfies it whether or not the model annotated it.
  // What still fails closed: a DECLARED claim the task does not
  // actually perform (validated above — fabricated evidence, never an
  // authority grant), a claim on PAIR bookkeeping (above), and any row
  // no task existentially provides (PLAN_INCOMPLETE below).

  const incomplete = (req: GoalRequirement): never => {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_INCOMPLETE",
      JSON.stringify({
        requirement: req.id,
        kind: req.kind,
        text: req.text.slice(0, 160),
      }),
    );
  };
  const violated = (req: GoalRequirement, why: string): never => {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
      JSON.stringify({
        requirement: req.id,
        kind: req.kind,
        why,
        text: req.text.slice(0, 160),
      }),
    );
  };

  for (const req of contract.obligations) {
    const hits = work.filter((t) => covers(t, req)).map((t) => String(t.task_key));
    if (!hits.length) incomplete(req);
    rows.push({ requirement_id: req.id, kind: req.kind, state: "PROVEN", task_keys: hits });
  }
  for (const req of contract.deliverables) {
    const hits = work.filter((t) => covers(t, req)).map((t) => String(t.task_key));
    if (!hits.length) incomplete(req);
    rows.push({ requirement_id: req.id, kind: req.kind, state: "PROVEN", task_keys: hits });
  }
  for (const req of contract.constraints) {
    // Bounded direct validation only where the constraint exposes a
    // checkable quantity (e.g. a budget ceiling): a task instruction
    // asserting a larger explicit amount is a proven contradiction.
    if (req.maxAmount !== undefined) {
      let sawAmount = false;
      for (const t of work) {
        const instr = String(t.task_instruction ?? "");
        for (const amt of instructionAmounts(instr)) {
          sawAmount = true;
          if (amt > req.maxAmount) {
            violated(req, `task ${String(t.task_key)} asserts amount ${amt} > budget ${req.maxAmount}`);
          }
        }
      }
      // No checkable amount → preserved, never claimed proven.
      rows.push({
        requirement_id: req.id,
        kind: req.kind,
        state: sawAmount ? "PROVEN" : "PRESERVED",
        task_keys: [],
      });
      continue;
    }
    // `only X` bounds: a mandatory bounded constraint may not be
    // silently dropped — the permitted value must be carried into the
    // relevant executable work. A known sibling → VIOLATION; nothing
    // carrying the value → the constraint is uncovered → INCOMPLETE.
    if (req.onlyTerms?.length) {
      for (const t of work) {
        const instr = String(t.task_instruction ?? "");
        const bad = violatesOnlyConstraint(instr, req.onlyTerms);
        if (bad) {
          violated(req, `task ${String(t.task_key)} invokes "${bad}" excluded by only=${req.onlyTerms.join(",")}`);
        }
      }
      const carries = (t: Record<string, unknown>, term: string): boolean =>
        onlyConstraintEvidence(String(t.task_instruction ?? ""), term);
      // Relevance binding: the value must be carried by the constrained
      // work itself — a requirement-covering task (never bookkeeping,
      // never an unrelated dummy that merely mentions the term). A
      // channel `only` binds tasks that engage that channel dimension.
      const coversMandatory = (t: Record<string, unknown>): boolean =>
        contract.obligations.some((o) => covers(t, o)) ||
        contract.deliverables.some((d) => covers(t, d));
      const satisfied = req.onlyTerms.every((term) =>
        work.some((t) =>
          carries(t, term) && (ONLY_CHANNELS.has(term) || coversMandatory(t)),
        ),
      );
      if (!satisfied) incomplete(req);
      rows.push({
        requirement_id: req.id,
        kind: req.kind,
        state: "PROVEN",
        task_keys: [],
      });
      continue;
    }
    // Constraints PAIR cannot directly validate are preserved as
    // requirements the plan must not contradict — recorded, never
    // silently dropped, and never claimed PROVEN.
    rows.push({ requirement_id: req.id, kind: req.kind, state: "PRESERVED", task_keys: [] });
  }
  for (const req of contract.prohibitions) {
    const terms = req.terms ?? [];
    const classes = new Set(req.actionClass ?? []);
    for (const t of work) {
      const instr = String(t.task_instruction ?? "");
      const caps = (t.required_capabilities as string[] | undefined) ?? [];
      // Capability authority is unchanged: a banned telegram surface is
      // violated by the capability claim itself, independent of wording.
      for (const term of terms) {
        if (TELEGRAM_PROHIBITED_TERMS.has(term) && caps.includes("TELEGRAM_DELIVERY")) {
          violated(req, `task ${String(t.task_key)} requests prohibited TELEGRAM_DELIVERY`);
        }
      }
      if (classes.size) {
        // Structured prohibition: violation requires performing a
        // compatible action ON a prohibited object in the same
        // instruction segment — mentioning the object elsewhere or
        // performing the action on a different object is not the act.
        // A ban with no object terms forbids the action class outright.
        const act = taskShowsProhibitedAct(instr, classes, terms);
        if (act) {
          violated(
            req,
            act.term
              ? `task ${String(t.task_key)} performs prohibited ${act.cls} on "${act.term}"`
              : `task ${String(t.task_key)} performs prohibited ${act.cls}`,
          );
        }
      } else {
        // No identifiable action — term-only enforcement (boundary
        // match, fail-closed for unparseable prohibition shapes).
        for (const term of terms) {
          if (termHit(instr, term)) {
            violated(req, `task ${String(t.task_key)} invokes prohibited term "${term}"`);
          }
        }
      }
    }
    rows.push({ requirement_id: req.id, kind: req.kind, state: "PROVEN", task_keys: [] });
  }
  if (contract.deadline) {
    // Deadlines are preserved verbatim; PAIR has no scheduling engine,
    // and invented dates are forbidden — recorded, never adjudicated.
    rows.push({
      requirement_id: contract.deadline.id,
      kind: "constraint",
      state: "PRESERVED",
      task_keys: [],
    });
  }
  return { contractDigest: contract.contractDigest, verdict: "PASS", rows };
}
