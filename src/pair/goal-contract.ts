/**
 * PRV2-B — Goal Contract: the deterministic canonical extraction of what
 * the operator's raw goal REQUIRES. One goal → one immutable contract.
 *
 * The contract is the coverage authority the plan is checked against
 * BEFORE it can pin: every mandatory obligation must map to a genuine
 * work task, every deliverable to a producer, every prohibition must be
 * respected, bounded constraints must not be contradicted. See
 * plan-coverage.ts for the verification seam.
 *
 * Design rules (mandate):
 *  - deterministic + bounded — no LLM classification, no entity DB;
 *  - conservative incompleteness over invention: a clause that cannot be
 *    classified contributes only to `objective`, never a requirement;
 *  - quantities are PRESERVED (operator "20" → min 20, never "some");
 *  - existing authorities are referenced, never duplicated:
 *    telegram intent / output language / network detection all live in
 *    their own modules; the contract stores their results verbatim;
 *  - replans derive the SAME contract because the raw goal is immutable —
 *    replanning changes HOW the goal is satisfied, never WHAT.
 */

import { createHash } from "node:crypto";
import { detectTelegramDeliveryIntent, type TelegramDeliveryIntent } from "./plan-dataflow.js";
import { detectOutputLanguage, type OutputLanguage } from "./output-language.js";

export interface GoalRequirement {
  /** Stable deterministic id by extraction order — never a UUID. */
  id: string;
  kind: "obligation" | "deliverable" | "constraint" | "prohibition";
  /** The exact operator clause this requirement was extracted from. */
  text: string;
  /** Numeric bound preserved from the clause, if stated. */
  quantity?: { min?: number; max?: number };
  /** For deliverables: the exact filename the operator named. */
  target?: string;
  /** For prohibitions: the distilled content terms the plan must avoid. */
  terms?: string[];
  /** For prohibitions: the bounded forbidden-action class(es) the clause
   *  bans (e.g. delete/use/send). A task violates only when it performs
   *  a compatible action ON a prohibited object — mentioning the object
   *  to inspect/research it is never the prohibited act. Absent when no
   *  action verb is identifiable (term-only enforcement). */
  actionClass?: string[];
  /** For budget-like constraints: the operator's ceiling amount. */
  maxAmount?: number;
  /** For `only X`-bounded constraints: the explicit permitted value(s). */
  onlyTerms?: string[];
}

export interface GoalContract {
  /** Human-readable objective: the goal's leading clause, verbatim. */
  objective: string;
  obligations: GoalRequirement[];
  deliverables: GoalRequirement[];
  constraints: GoalRequirement[];
  prohibitions: GoalRequirement[];
  deadline: { id: string; text: string } | null;
  /** Canonical reference into the existing delivery authority. */
  delivery_intent: TelegramDeliveryIntent;
  /** Canonical reference into the existing output-language authority. */
  output_language: OutputLanguage;
  /** sha256 of the canonical serialization — immutable plan evidence. */
  contractDigest: string;
}

/* ------------------------------------------------------------------ */
/* authority boundary                                                  */
/* ------------------------------------------------------------------ */

/** A delegated mission goal is an ENVELOPE, not flat operator text:
 *  `boundMissionGoal` emits a `[BUSINESS … | DEPT … | AGENT …]`
 *  provenance header, then the operator goal, then appended machine
 *  sections such as `[AGENT CONTEXT — last N outcomes]` followed by
 *  history bullets (`- [delegated] …`). The appended sections are
 *  supporting context for the planner — they must never mint
 *  obligations, deliverables, constraints, or prohibitions. Live
 *  incident: a history bullet leading with a work verb minted a
 *  fabricated OBL requirement, coverage failed closed
 *  (FAIL_CLOSED_PLAN_INCOMPLETE), the planner run exhausted, and the
 *  objective recorded INTEGRITY_FAULT.
 *
 *  The boundary is STRUCTURAL, never lexical. The goal is decomposed
 *  into blank-line-separated blocks; a block after the first whose
 *  every line is a whole-line section header (`[NAME …]`) or a list
 *  bullet is appended machine context and carries no requirement
 *  authority. Whole-line bracketed headers are section labels wherever
 *  they appear and never mint requirements (the `[BUSINESS …]`
 *  provenance line included — a business named "Write Co" must not
 *  mint a "Write" obligation). The first block is always operator-
 *  authored, so its own bullets remain real requirements even when the
 *  goal is itself a list.
 *
 *  This projection governs ONLY authority derivation (contract +
 *  intent/language detection at the planner and mission seams). The
 *  raw enriched goal still reaches the planner prompt verbatim as
 *  supporting context, and the persisted mission goal / goal_digest /
 *  pinned-plan digests are untouched. */
const SECTION_HEADER_RE = /^\s*\[[^\]\n]+\]\s*$/u;
const LIST_ITEM_RE = /^\s*(?:[-*•–—]|\d{1,3}[.)])\s/u;

/** Project a (possibly enriched) goal down to the text that may mint
 *  authority: drops appended `[SECTION]` + bullet metadata sections and
 *  standalone section-header lines; keeps operator text verbatim. */
export function authoritativeGoalText(goal: string): string {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of String(goal ?? "").split(/\r?\n/)) {
    if (line.trim() === "") {
      if (cur.length > 0) {
        blocks.push(cur);
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur);

  const kept: string[][] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isMetadataSection =
      i > 0 &&
      block.some((l) => SECTION_HEADER_RE.test(l)) &&
      block.every(
        (l) => SECTION_HEADER_RE.test(l) || LIST_ITEM_RE.test(l),
      );
    if (isMetadataSection) continue;
    const text = block.filter((l) => !SECTION_HEADER_RE.test(l));
    if (text.length > 0) kept.push(text);
  }
  return kept.map((b) => b.join("\n")).join("\n\n");
}

/* ------------------------------------------------------------------ */
/* clause splitting                                                    */
/* ------------------------------------------------------------------ */

/** A goal is decomposed into clauses by hard separators plus leading
 *  connectives, so "research competitors, compare pricing, propose 3
 *  strategies" yields its three work clauses. Conservative: anything
 *  unclassifiable stays objective-only and never becomes a requirement. */
function splitClauses(goal: string): string[] {
  // List numbering is punctuation, never quantity: "1. fetch X 2. fetch
  // Y" splits into clean items, and the item numbers must not become a
  // clause's numeric bound.
  const text = goal
    .normalize("NFC")
    .slice(0, 8192)
    .replace(/(^|\s)\d{1,2}[.)]\s+/g, "$1\n");
  const hard = text.split(/\r?\n|;|(?<=[^.]\.)\s+|\u2022|-\s+/u);
  const clauses: string[] = [];
  for (const h of hard) {
    for (const seg of splitSegGuarded(h)) {
      for (const part of splitConnectiveGuarded(seg)) {
        const s = part.trim();
        if (s) clauses.push(s);
      }
    }
  }
  return clauses.slice(0, 32);
}

/** `and`/`và` inside a prohibition action phrase is a CONNECTOR, not a
 *  clause boundary — "do not delete and modify report.md" must keep
 *  [delete, modify] joined or the second forbidden action is lost to
 *  the split. The guard is bounded and fires only when (a) a
 *  prohibition trigger already exists earlier in the same clause-so-far
 *  AND (b) both flanking words are forbidden-action shapes
 *  (ACTION_TAIL_RE / ACTION_LEAD_RE). `or`/`hoặc` were never clause
 *  separators; `and`/`và` everywhere else still splits normally. */
const CONNECTIVE_GUARD_RE = /\s+(?:và|and)\s+/giu;
function splitConnectiveGuarded(seg: string): string[] {
  const out: string[] = [];
  let last = 0;
  CONNECTIVE_GUARD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONNECTIVE_GUARD_RE.exec(seg)) !== null) {
    const before = seg.slice(last, m.index);
    const after = seg.slice(m.index + m[0].length);
    // A connector flanked by path tokens joins members of ONE artifact
    // list — "Tạo hai file input/a.txt và input/b.txt" must stay one
    // produce clause or the second file can never mint a deliverable.
    // Filename on only one flank is ordinary work punctuation: split.
    if (
      FILE_EDGE_TAIL_RE.test(before) &&
      FILE_EDGE_HEAD_RE.test(after)
    ) {
      continue;
    }
    if (
      PROHIBITION_RE.test(before) &&
      ACTION_TAIL_RE.test(before.trimEnd()) &&
      ACTION_LEAD_RE.test(after)
    ) {
      continue; // connector joins two forbidden actions — keep joined
    }
    out.push(seg.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(seg.slice(last));
  return out;
}

/** The comma separator gets the same bounded file-list guard: "Tạo các
 *  file a.md, b.csv và c.txt" only preserves all three targets if the
 *  commas inside the list do not split the produce clause. Phrase
 *  separators (then/sau đó/rồi/and then) always split — they separate
 *  work, never list members. */
const SEG_SPLIT_RE =
  /\s*(?:,|(?:\s+)(?:and then|then|sau đó|rồi)\s+)/giu;
function splitSegGuarded(seg: string): string[] {
  const out: string[] = [];
  let last = 0;
  SEG_SPLIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEG_SPLIT_RE.exec(seg)) !== null) {
    if (
      m[0].includes(",") &&
      FILE_EDGE_TAIL_RE.test(seg.slice(0, m.index)) &&
      FILE_EDGE_HEAD_RE.test(seg.slice(m.index + m[0].length))
    ) {
      continue;
    }
    out.push(seg.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(seg.slice(last));
  return out;
}

/* ------------------------------------------------------------------ */
/* classification vocabulary (bounded EN + VI, no classifiers)         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* forbidden-action vocabulary — single source for trigger + payload    */
/* ------------------------------------------------------------------ */

/** Per-class surface alternation bodies — boundaries are applied
 *  uniformly by ACTION_TOKEN_RE so no class owns its own edge. Every
 *  surface form is an explicit inflection (R1): arbitrary prefixes
 *  never mint an action (`use` must not match `user`/`useful`, `ran`
 *  must not match `orange`). Observation verbs (check/research/analyze/
 *  review/verify/read/monitor) are deliberately absent — a task that
 *  merely inspects the object is never the prohibited act.
 *  R2 — `order/ordering` left the trade class: data-ordering prose
 *  ("order results by score") is not a trade; only the contextual
 *  `place (an|the|some|N) order` phrase remains. */
const ACTION_FORMS: ReadonlyArray<{ cls: string; forms: string }> = [
  { cls: "delete", forms: "deletes?|deleted|deleting|removes?|removed|removing|drops?|dropped|dropping|erases?|erased|erasing|xóa|xoá|loại\\s+bỏ|hủy|huỷ|hủy\\s+bỏ|huỷ\\s+bỏ" },
  { cls: "use", forms: "uses?|using|used|utili[sz]es?|utili[sz]ed|utili[sz]ing|appl(?:y|ies|ied|ying)|employs?|employed|employing|adopts?|adopted|adopting|incorporates?|incorporated|incorporating|includes?|included|including|dùng|sử\\s+dụng|áp\\s+dụng|vận\\s+dụng" },
  { cls: "send", forms: "sends?|sent|sending|delivers?|delivered|delivering|posts?|posted|posting|forwards?|forwarded|forwarding|shares?|shared|sharing|broadcasts?|broadcasting|gửi|đăng(?!\\s+(?:nhập|ký))|chia\\s+sẻ" },
  { cls: "access", forms: "access(?:es|ed|ing)?|invokes?|invoked|invoking|touch(?:es|ed|ing)?|reach(?:es|ed|ing)?|connect(?:s|ed|ing|ion)?|logs?\\s*in|logging\\s+in|calls?|called|calling|truy\\s+cập|kết\\s+nối|đăng\\s+nhập|liên\\s+hệ" },
  { cls: "execute", forms: "runs?|ran|running|executes?|executed|executing|execution|launch(?:es|ed|ing)?|starts?|started|starting|boots?|booted|booting|deploys?|deployed|deploying|chạy|thực\\s+thi|khởi\\s+chạy|triển\\s+khai" },
  { cls: "modify", forms: "modif(?:y|ies|ied|ying|ication)?|edits?|edited|editing|overwrit(?:e|es|ing|ten)|chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|alters?|altered|altering|appends?|appended|appending|sửa(?:\\s+đổi|\\s+chữa)?|ghi\\s+đè|thay\\s+đổi|cập\\s+nhật|chỉnh(?:\\s+sửa)?" },
  { cls: "fabricate", forms: "fabricates?|fabricated|fabricating|invents?|invented|inventing|forges?|forged|forging|fakes?|faked|faking|hallucinates?|hallucinated|hallucinating|bịa(?:\\s+đặt|\\s+ra)?|ngụy\\s+tạo|giả\\s+mạo" },
  { cls: "trade", forms: "trades?|traded|trading|buys?|bought|buying|sells?|sold|selling|deals?|dealt|dealing|plac(?:e|es|ed|ing)\\s+(?:(?:an?|the|some|few|\\d+)\\s+)?orders?|giao\\s+dịch|mua|bán|đặt\\s+lệnh|đầu\\s+tư|ký\\s+gửi" },
  { cls: "copy", forms: "cop(?:y|ies|ied|ying)|duplicates?|duplicated|duplicating|clones?|cloned|cloning|sao\\s+chép|nhân\\s+bản" },
  { cls: "install", forms: "installs?|installed|installing|cài(?:\\s+đặt)?" },
  { cls: "download", forms: "downloads?|downloaded|downloading|tải(?:\\s+xuống|\\s+về)?" },
  { cls: "write", forms: "writes?|wrote|written|writing|drafts?|drafted|drafting|composes?|composed|composing|viết|soạn" },
];

const ACTION_TOKEN_RE = (body: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

/** Bounded forbidden-action vocabulary — the role PROHIBITED_VERB_STRIP
 *  was declared for, made real: a prohibition bans a PERFORMING action
 *  on its object, not the vocabulary around it. */
export const PROHIBITION_ACTION_CLASSES: ReadonlyArray<{
  cls: string;
  re: RegExp;
}> = ACTION_FORMS.map(({ cls, forms }) => ({
  cls,
  re: ACTION_TOKEN_RE(forms),
}));

const ALL_ACTION_FORMS = ACTION_FORMS.map((f) => f.forms).join("|");
/** Action-shape checks for the clause-splitting guard — "does the word
 *  after a connective begin a forbidden action" / "does the text before
 *  it end in one" (e.g. `delete and modify`, `xóa và sửa`). */
const ACTION_LEAD_RE = new RegExp(`^(?:${ALL_ACTION_FORMS})(?![\\p{L}\\p{N}])`, "iu");
const ACTION_TAIL_RE = new RegExp(`(?:${ALL_ACTION_FORMS})$`, "iu");

/** Prohibition triggers. R2 — bare `không` mints a prohibition ONLY
 *  when it leads directly into a known forbidden-action phrase
 *  (`không dùng/gửi/xóa/sử dụng/đặt lệnh…`): a negative describing a
 *  property (`không quá`, `không có`, `không martingale`) is never a
 *  ban — the trigger needs structural action evidence, not a
 *  suppress-word list. Multi-word triggers (`không được|không đc|
 *  không nên`) keep matching explicitly. Boundaries are unicode
 *  lookarounds — JS `\b` is ASCII-only and can never see `đừng`/`ế`-
 *  edged words. */
const PROHIBITION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:do not|don't|do n't|never|must not|shall not|may not|cannot|không được|không đc|không nên|đừng|cấm|tránh|không(?=\\s+(?:${ALL_ACTION_FORMS})(?![\\p{L}\\p{N}])))(?![\\p{L}\\p{N}])`,
  "iu",
);

/** Conditional openers — a prohibition tail that scopes WHEN the ban
 *  applies is condition vocabulary, never prohibited content. The ban
 *  itself lives in the clause head (or, when the marker opens the
 *  clause, in the text after the condition). Boundaries are unicode
 *  lookarounds so `miễn là`/`nếu`-style accented edges match and a
 *  marker embedded in a longer token never does. */
const CONDITIONAL_MARKER_RE =
  /(?<![\p{L}\p{N}])(?:trừ khi|miễn là|trong trường hợp|in case|as long as|so long as|provided that|provided|unless|if|when|nếu|khi(?!\s*nào)|lúc(?!\s*nào))(?![\p{L}\p{N}])/iu;
const TAIL_CONNECTOR_RE = /^(?:thì|then|that|là)\s+/iu;

/** The part of a prohibition clause that carries the ban — the head
 *  before a conditional marker when that head is trigger+payload, else
 *  the prohibition that follows the condition, else the clause itself
 *  (an embedded marker like "khi nào"/"bao giờ" never splits). */
function prohibitionHead(clause: string): string {
  const m = CONDITIONAL_MARKER_RE.exec(clause);
  if (!m) return clause;
  const before = clause.slice(0, m.index);
  if (
    PROHIBITION_RE.test(before) &&
    /[\p{L}\p{N}]{2,}/u.test(before.replace(PROHIBITION_RE, " "))
  ) {
    return before;
  }
  const after = clause.slice(m.index + m[0].length).replace(TAIL_CONNECTOR_RE, "");
  const trig = PROHIBITION_RE.exec(after);
  if (trig) return after.slice(trig.index);
  return clause;
}

const DEADLINE_RE =
  /\bdeadline\b|\bdue\b|\bhạn\b|\btrước ngày\b|\btrước\b.{0,12}\b(?:giờ|ngày)\b|\bby\s+\d{1,2}[/-]\d{1,2}/iu;

const CONSTRAINT_RE =
  /\bbudget\b|\bngân sách\b|\btối đa\b|\bkhông quá\b|\bonly\b|\bchỉ\b|\bchỉ được\b|\bngoại trừ\b|\bexcept\b|\bin (?:english|vietnamese|spanish|french|japanese)\b|\bbằng tiếng\b|\b(?:max|maximum|up to|at most)\s+\d|\b(?:<=|≤)\s*\$?\s*\d/i;

const BUDGET_RE =
  /\bbudget\b[^\d]{0,20}(\d+(?:\.\d+)?)|\bngân sách\b[^\d]{0,20}(\d+(?:\.\d+)?)|\$(\d+(?:\.\d+)?)\s*(?:budget|max|tối đa)/i;

/** Extension vocabulary shared by FILE_RE and the clause-split edge
 *  checks — the split guards recognize exactly the path shapes the
 *  extractor mints, nothing more. */
const FILE_EXT_GROUP =
  "md|txt|json|csv|pdf|html?|png|jpe?g|webp|svg|ts|tsx|js|mjs|py|ipynb|docx?|xlsx|zip|mq[45]";
const FILE_RE = new RegExp(
  `\\b((?:[\\w-]+\\/)*[\\w][\\w.-]*\\.(?:${FILE_EXT_GROUP}))\\b`,
  "gi",
);
/** Bounded file-list evidence for the clause splitters: does the text
 *  end / begin with a filename-or-path token? A separator flanked by
 *  both is joining members of one artifact list. */
const FILE_EDGE_TAIL_RE = new RegExp(
  `(?:[\\w-]+\\/)*[\\w][\\w.-]*\\.(?:${FILE_EXT_GROUP})[.]?\\s*$`,
  "i",
);
const FILE_EDGE_HEAD_RE = new RegExp(
  `^\\s*(?:[\\w-]+\\/)*[\\w][\\w.-]*\\.(?:${FILE_EXT_GROUP})[.]?(?![\\w.-])`,
  "i",
);

/** Canonical produce vocabulary — the single source feeding both the
 *  clause-level PRODUCE_VERB_RE (obligation dedup below) and the
 *  governing-token set used by produce→object binding. One list so the
 *  two authorities can never drift apart. */
const PRODUCE_WORDS = [
  "create", "write", "produce", "generate", "save", "draft", "export",
  "render", "emit", "build",
  "tạo", "viết", "soạn", "lưu", "xuất", "sinh",
] as const;
const PRODUCE_VERB_RE = new RegExp(`\\b(?:${PRODUCE_WORDS.join("|")})\\b`, "iu");
const PRODUCE_GOVERNING_WORDS = new Set<string>(PRODUCE_WORDS);

/** Produce→object binding (M3 CASE_B): a filename mints DEL_* only when
 *  its leftward governing token is a produce verb. Clause-level
 *  co-occurrence of a produce verb and a filename is NOT binding —
 *  "tạo PR ... sửa src/foo.test.ts" must not fabricate a deliverable for
 *  the modify-target file. The backward scan stops at the first
 *  governing token; connectives, other filenames, filler and unknown
 *  words pass through; destination prepositions (to/vào/into/thành/ra)
 *  pass through — the verb before them governs ("write results to
 *  report.md" produces report.md). Source/context prepositions and
 *  non-produce action verbs stop the scan with NO mint — the file is an
 *  input, a modify-target, or a contextual mention. Reaching clause
 *  start without a governing verb → no mint: conservative incompleteness
 *  beats a fabricated requirement.
 *
 *  R1 refinements (over-narrow audit):
 *  - Only tokens that can govern a file BY THEMSELVES stop the scan.
 *    Vietnamese disyllabic-verb fragments (phân/tích, kiểm/tra,
 *    nghiên/cứu, ...) never govern alone and routinely appear inside
 *    noun phrases ("báo cáo phân tích" = analysis report) — treating
 *    them as boundaries false-blocked the real produce verb further
 *    left. Same for bare "test" ("test report"). They pass through.
 *  - Ambiguous locatives (in/on/at/trên/trong) double as destination
 *    markers ("write results in report.md", "viết kết quả trong
 *    report.md") — they pass through; locative uses inside modify
 *    clauses stay protected by the modify verb further left.
 *  - A source preposition (from/từ/of) mid-scan still bounds the file
 *    — unless the file's own immediate preposition is an unambiguous
 *    destination marker ("viết từ notes.md ra report.md"), in which
 *    case the source phrase binds a different noun and the scan
 *    continues to the governing verb. */
const NON_PRODUCE_ACTION_WORDS = new Set([
  // Modify/delete class — the file is the object being changed or removed.
  "fix", "edit", "modify", "patch", "update", "change", "refactor",
  "rename", "move", "delete", "remove", "drop", "replace", "revert",
  "amend", "adjust", "tweak",
  "sửa", "chỉnh", "đổi", "thay", "xóa", "gỡ", "loại", "bỏ", "vá",
  "huỷ", "hủy",
  // Read/consume/inspect class — the file is an input being used.
  "read", "open", "load", "parse", "inspect", "review", "analyze",
  "analyse", "study", "survey", "check", "verify", "validate", "monitor",
  "fetch", "retrieve", "collect", "gather", "download", "scrape",
  "extract", "compare", "contrast", "assess", "evaluate", "use", "apply",
  "consume", "reference", "cite", "import", "merge", "watch",
  "đọc", "xem", "mở", "tải", "lấy", "tìm", "dùng", "nhập", "gộp",
]);
/** Context prepositions — a file reached through one of these is a
 *  source, topic or circumstance object, never the produced thing. */
const CONTEXT_PREP_WORDS = new Set([
  "from", "từ", "of", "within", "inside",
  "about", "về", "like", "như", "theo", "per", "based",
  "against", "với", "with", "for", "cho", "because", "vì", "by", "bởi",
  "via", "through", "qua", "over", "under", "behind", "before", "after",
  "sau", "trước", "giữa", "between", "among", "ngoài", "outside",
  "except", "trừ", "without", "để", "during", "khi", "lúc", "while",
  "since", "kể", "until", "beyond", "around", "near", "beside", "along",
  "kèm", "cùng", "vs", "versus",
]);
/** The subset whose phrase names the file's origin. When the file's own
 *  immediate preposition is an unambiguous destination marker, a source
 *  phrase elsewhere in the scan is binding a different noun — pass it. */
const SOURCE_PREP_WORDS = new Set(["from", "từ", "of"]);
/** Unambiguous destination markers — evidence the file sits in a
 *  destination slot governed by the produce verb further left. The
 *  ambiguous locatives (in/trong/on/at/trên) are deliberately absent:
 *  they pass through the scan but are not strong enough to float a
 *  source phrase. */
const DEST_PREP_WORDS = new Set([
  "to", "into", "onto", "as", "vào", "thành", "ra",
]);
/** Ambiguous locatives — destination-capable, so they may pass through
 *  the scan, BUT only on positive evidence (R3): the produced object
 *  left of the locative must be a file-content noun — "write results
 *  in report.md" mints report.md because results live INSIDE the file.
 *  Anything else (PR/function/class/endpoint/hàm/...) is a produced
 *  object that merely LOCATES the file — no mint. A denylist of such
 *  objects can never close this class; positive evidence can. */
const LOCATIVE_PREP_WORDS = new Set(["in", "trong", "on", "at", "trên"]);
/** Positive file-content vocabulary — things that live inside a file
 *  rather than locating one. Deliberately small and auditable; an
 *  unknown object simply fails closed. */
const FILE_CONTENT_OBJECT_WORDS = new Set([
  // English output/file-content nouns
  "result", "results", "report", "reports", "summary", "output",
  "outputs", "data", "content", "document", "documents", "doc", "docs",
  "documentation", "file", "files", "text", "note", "notes", "analysis",
  "findings", "code", "source", "spec", "plan", "plans", "draft",
  "log", "chart", "diagram", "guide",
  // Vietnamese equivalents (syllable-tokenized)
  "kết", "quả", "báo", "cáo", "nội", "dung", "dữ", "liệu", "tài",
  "văn", "bản", "ghi", "chú", "phân", "tích", "mã", "nguồn", "đặc",
  "tả", "kế", "hoạch", "tóm", "tắt", "nháp", "hướng", "dẫn", "biểu",
  "đồ",
]);
/** Fillers that may sit between the locative and its object — articles
 *  and near-article quantifiers only. */
const LOCATIVE_OBJECT_FILLER_WORDS = new Set([
  "a", "an", "the", "một", "cái", "new", "mới",
]);
const GOVERNING_WORD_RE = /[\p{L}\p{N}_]+/gu;
function isProduceGovernedFile(clause: string, fileIndex: number): boolean {
  const words = clause.slice(0, fileIndex).match(GOVERNING_WORD_RE) ?? [];
  const destBound =
    words.length > 0 &&
    DEST_PREP_WORDS.has(words[words.length - 1].toLowerCase());
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase();
    if (PRODUCE_GOVERNING_WORDS.has(w)) return true;
    if (NON_PRODUCE_ACTION_WORDS.has(w)) return false;
    if (SOURCE_PREP_WORDS.has(w) && destBound) continue;
    if (CONTEXT_PREP_WORDS.has(w)) return false;
    if (LOCATIVE_PREP_WORDS.has(w)) {
      // R4: judge the whole object phrase between the governing verb
      // and the locative — a single positive tail token is not enough
      // ("hàm phân tích" = coding-object head + content modifier; the
      // file still only locates the produced object). Every non-filler
      // word of the phrase must be file-content evidence.
      let j = i - 1;
      let sawContent = false;
      let pure = true;
      while (j >= 0) {
        const pw = words[j].toLowerCase();
        if (LOCATIVE_OBJECT_FILLER_WORDS.has(pw)) {
          j--;
          continue;
        }
        if (
          PRODUCE_GOVERNING_WORDS.has(pw) ||
          NON_PRODUCE_ACTION_WORDS.has(pw) ||
          CONTEXT_PREP_WORDS.has(pw) ||
          SOURCE_PREP_WORDS.has(pw) ||
          DEST_PREP_WORDS.has(pw) ||
          LOCATIVE_PREP_WORDS.has(pw)
        ) {
          break;
        }
        if (!FILE_CONTENT_OBJECT_WORDS.has(pw)) {
          pure = false;
          break;
        }
        sawContent = true;
        j--;
      }
      if (!sawContent || !pure) return false;
      continue;
    }
  }
  return false;
}

/** Work verbs that make a clause an obligation. Delivery verbs (send /
 *  gửi / deliver) are deliberately absent — delivery is governed by the
 *  existing telegram intent authority, never by an obligation row. */
const LEADING_FILLER_RE =
  /^(?:please|hãy|xin|first(?:ly)?|also|then|next|finally|lastly|đầu tiên|tiếp(?: theo)?|sau đó|rồi|bây giờ|sau khi|ok(?:ay)?|and|và|\d{1,2}[.)]|[•\-–—*])\s*/iu;

const OBLIGATION_VERB_RE =
  /\b(?:research|analy[sz]e|analyse|assess|evaluat|review|study|investigat|survey|compar|benchmark|contrast|propos|recommend|suggest|deriv|identify|fetch|retriev|collect|gather|download|scrape|extract|creat|writ|build|develop|design|implement|produc|generat|draft|save|export|render|comput|calculat|measure|quantif|estimat|forecast|plot|draw|chart|graph|summar|digest|test|verif|validat|check|monitor|track|translat|deploy|publish|list|rank|score|select|choose|screen|nghiên cứu|phân tích|đánh giá|xem xét|khảo sát|so sánh|đối chiếu|đề xuất|xác định|lấy|tải|thu thập|tra cứu|tìm|tạo|viết|soạn|lưu|xuất|xây|phát triển|thiết kế|triển khai|tính|ước tính|dự báo|vẽ|tóm tắt|kiểm tra|kiểm|theo dõi|giám sát|dịch|liệt kê|xếp hạng|chọn)/iu;

const QUANTITY_MIN_RE =
  /\b(?:at least|minimum of|min(?:imum)?|no fewer than|ít nhất|tối thiểu|>=|≥)\s*(\d+)/iu;
const QUANTITY_MAX_RE =
  /\b(?:at most|up to|maximum of|no more than|tối đa|không quá|<=|≤)\s*(\d+)/iu;
const QUANTITY_EXACT_RE =
  /\b(?:exactly|đúng|chính xác)\s+(\d+)/iu;
const BARE_NUM_RE = /\b(\d{1,6})\b/;

/** Tokens that may appear inside a prohibition clause but are not the
 *  prohibited thing itself (verbs, articles, negation words). */
const PROHIBITION_STOPWORDS = new Set([
  "do", "not", "never", "must", "shall", "may", "cannot", "don", "không",
  "được", "đừng", "cấm", "nên", "tránh", "use", "using", "send",
  "sending", "run", "running", "deliver", "post", "include", "access",
  "call", "invoke", "touch", "any", "anything", "except", "ngoại",
  "trừ", "the", "a", "an", "to", "for", "with", "from", "tới", "đến",
  "qua", "qua lại", "on", "in", "dùng", "sử", "dụng", "gửi", "chạy",
  "đăng", "bất", "kỳ", "gì", "phải", "cần", "có",
  // conditional + connective vocabulary — scoping words, never the
  // prohibited object
  "if", "when", "unless", "nếu", "khi", "miễn", "trường", "hợp", "thì",
  "nào", "bao", "giờ", "case", "provided", "long", "as", "and", "or",
  "nor", "else", "than", "hoặc", "cùng", "với", "của", "cho", "là",
  "các", "những", "một", "mỗi", "vào", "ra", "lên", "xuống", "lại",
  "hết", "còn", "sau", "trước", "giữa", "dưới", "ở", "tại", "về",
  "theo", "như",
  // file extensions — identity lives in the stem, never the suffix
  "txt", "md", "json", "csv", "pdf", "html", "png", "jpg", "jpeg",
  "webp", "svg", "ts", "tsx", "js", "mjs", "py", "ipynb", "doc",
  "docx", "xlsx", "zip",
]);

function extractQuantity(clause: string): { min?: number; max?: number } | undefined {
  const minM = QUANTITY_MIN_RE.exec(clause);
  const maxM = QUANTITY_MAX_RE.exec(clause);
  const exactM = QUANTITY_EXACT_RE.exec(clause);
  const q: { min?: number; max?: number } = {};
  if (exactM) {
    const n = Number(exactM[1]);
    q.min = n;
    q.max = n;
  } else {
    if (minM) q.min = Number(minM[1]);
    if (maxM) q.max = Number(maxM[1]);
    if (q.min === undefined && q.max === undefined) {
      // A bare quantity in a work clause is the operator's stated floor —
      // "propose 3 strategies" means at least 3, never "some".
      const bare = BARE_NUM_RE.exec(clause);
      if (bare) q.min = Number(bare[1]);
    }
  }
  return q.min !== undefined || q.max !== undefined ? q : undefined;
}

/** `only X` / `X only` / `chỉ (dùng) X` — the explicit bounded value an
 *  `only`-constraint permits. Only concrete tokens count; function words
 *  ("only the results") never mint a bound. For the `X only` form the
 *  bound is the digit-bearing identity token nearest `only` when one
 *  exists ("research MQL5 EAs only" → mql5), else the token directly
 *  preceding it. The three orders are tried independently — a leftmost
 *  alternation match ("use only" capturing "use") can never win. */
const ONLY_AFTER_RE = /\bonly\s+([\p{L}\p{N}_-]+)/iu;
const ONLY_BEFORE_RE = /([\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+){0,2})\s+only\b/iu;
const ONLY_VI_RE = /\bchỉ\s+(?:dùng\s+|dụng\s+)?([\p{L}\p{N}_-]+)/iu;
const ONLY_TERM_STOP = new Set([
  "the", "a", "an", "this", "that", "these", "those", "one", "two",
  "for", "to", "in", "on", "at", "of", "with", "by", "as", "be",
  "use", "using", "dùng", "dụng", "if", "when", "than", "then",
]);

function extractOnlyTerms(clause: string): string[] | undefined {
  const m1 = ONLY_AFTER_RE.exec(clause);
  const m3 = ONLY_VI_RE.exec(clause);
  let term = (m1?.[1] ?? m3?.[1] ?? "").toLowerCase();
  if (!term) {
    const m2 = ONLY_BEFORE_RE.exec(clause);
    if (m2) {
      const words = m2[1].toLowerCase().split(/\s+/).filter(Boolean);
      const versioned = [...words].reverse().find((w) => /\d/.test(w));
      term = versioned ?? words[words.length - 1] ?? "";
    }
  }
  if (term.length < 2 || ONLY_TERM_STOP.has(term)) return undefined;
  return [term];
}

/** Connectors that legally extend a forbidden-action phrase —
 *  "delete or modify" mints both classes; "access download" (no
 *  connector) mints `access` only, `download` stays object identity. */
const ACTION_CONNECTOR_WORDS = new Set(["or", "and", "và", "hoặc"]);
/** Filename-shaped tokens are objects, never actions — masked before
 *  the action scan so `write.txt` cannot mint a `write` class. */
const FILELIKE_TOKEN_RE = /[\p{L}\p{N}_-]+\.[\p{L}\p{N}]+/gu;

/** The structured prohibition payload: the bounded action class(es)
 *  the clause bans plus the object terms it bans them on. Everything
 *  after a conditional marker is scoping, never prohibited content.
 *  R1 — action classes come from the ACTION PHRASE alone: the first
 *  action-verb match plus later matches bridged only by connectors.
 *  An action-looking token sitting in the object keeps its identity
 *  in `terms` and never mints a second forbidden action. */
function prohibitionPayload(clause: string): {
  terms: string[];
  actionClass?: string[];
} {
  const head = prohibitionHead(clause).replace(PROHIBITION_RE, " ");
  const masked = head.replace(FILELIKE_TOKEN_RE, (t) => " ".repeat(t.length));
  const wordTokens = [...masked.matchAll(/[\p{L}\p{N}]+/gu)];
  // Every action-class surface match, sorted by position (ties: the
  // longer match wins — `đăng nhập` reads access, not send).
  const hits: Array<{ tok: number; cls: string; start: number; end: number }> = [];
  for (const { cls, re } of PROHIBITION_ACTION_CLASSES) {
    const g = new RegExp(re.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = g.exec(masked)) !== null) {
      const start = m.index;
      const tok = wordTokens.findIndex(
        (t) => start >= t.index! && start < t.index! + t[0].length,
      );
      if (tok >= 0) hits.push({ tok, cls, start, end: start + m[0].length });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const classes: string[] = [];
  const spans: Array<[number, number]> = [];
  if (hits.length) {
    classes.push(hits[0].cls);
    spans.push([hits[0].start, hits[0].end]);
    let prev = hits[0];
    for (let k = 1; k < hits.length && classes.length < 4; k++) {
      const h = hits[k];
      if (h.start < prev.end) continue; // overlap with an admitted span
      // word tokens lying strictly between the two spans — all must be
      // connectors for the later match to join the action phrase
      const gap = wordTokens
        .filter((t) => t.index! >= prev.end && t.index! + t[0].length <= h.start)
        .map((t) => t[0].toLowerCase());
      if (!gap.length || !gap.every((w) => ACTION_CONNECTOR_WORDS.has(w))) break;
      if (!classes.includes(h.cls)) classes.push(h.cls);
      spans.push([h.start, h.end]);
      prev = h;
    }
  }
  // Terms come from the whole head minus the admitted action spans —
  // object identity (including action-looking tokens) survives intact.
  let stripped = "";
  let cursor = 0;
  for (const [s, e] of spans) {
    stripped += head.slice(cursor, s) + " ";
    cursor = e;
  }
  stripped += head.slice(cursor);
  const terms: string[] = [];
  for (const m of stripped.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || PROHIBITION_STOPWORDS.has(w)) continue;
    if (!terms.includes(w)) terms.push(w);
  }
  return {
    terms: terms.slice(0, 8),
    ...(classes.length ? { actionClass: classes.slice(0, 4) } : {}),
  };
}

/** Extract the Goal Contract — the deterministic, append-only projection
 *  of the authoritative operator goal. Same input → same contract,
 *  always. Appended machine context (agent history, provenance headers)
 *  is projected out first and can never mint a requirement. */
export function extractGoalContract(goal: string): GoalContract {
  const raw = authoritativeGoalText(goal);
  const clauses = splitClauses(raw);
  // A prohibition trigger opening mid-clause scopes only its own span —
  // "phân tích EA không dùng martingale" keeps the `phân tích EA`
  // obligation AND mints the `use` prohibition; the trigger must not
  // swallow mandatory work stated earlier in the same clause.
  const expanded: string[] = [];
  for (const c of clauses) {
    const tm = PROHIBITION_RE.exec(c);
    if (tm && tm.index > 0 && /[\p{L}\p{N}]/u.test(c.slice(0, tm.index))) {
      expanded.push(c.slice(0, tm.index).trim());
      expanded.push(c.slice(tm.index).trim());
    } else {
      expanded.push(c);
    }
  }
  const obligations: GoalRequirement[] = [];
  const deliverables: GoalRequirement[] = [];
  const constraints: GoalRequirement[] = [];
  const prohibitions: GoalRequirement[] = [];
  let deadline: { id: string; text: string } | null = null;

  const push = (
    arr: GoalRequirement[],
    prefix: string,
    text: string,
    extra: Partial<GoalRequirement> = {},
  ) => {
    arr.push({
      id: `${prefix}_${String(arr.length + 1).padStart(3, "0")}`,
      kind: prefix === "OBL" ? "obligation"
        : prefix === "DEL" ? "deliverable"
        : prefix === "CON" ? "constraint"
        : "prohibition",
      text: text.slice(0, 500),
      ...extra,
    });
  };

  for (const clause of expanded) {
    // Prohibition outranks everything — a clause that forbids also naming
    // a file or a verb must not mint a deliverable/obligation.
    if (PROHIBITION_RE.test(clause)) {
      push(prohibitions, "PRO", clause, prohibitionPayload(clause));
      continue;
    }
    // An explicit telegram-delivery clause is governed by the existing
    // intent authority — it mints neither obligation nor deliverable.
    if (detectTelegramDeliveryIntent(clause).requested) continue;
    // A clause carries as many orthogonal requirement dimensions as it
    // states: "research 20 MQL5 EAs by 31/10" is BOTH an obligation AND
    // a deadline; "research MQL5 EAs only" is BOTH an obligation AND a
    // constraint. No early continue may drop mandatory work.
    if (!deadline && DEADLINE_RE.test(clause)) {
      deadline = { id: "DDL_001", text: clause.slice(0, 500) };
    }
    // A filename mints DEL_* only when its leftward governing token is a
    // produce verb — clause-level co-occurrence of a produce verb and a
    // filename is not binding (M3 CASE_B: `tạo` governed "PR" while the
    // modify-target .test.ts in the same clause minted a fabricated
    // DEL_001). See isProduceGovernedFile.
    const files: string[] = [];
    FILE_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FILE_RE.exec(clause)) !== null) {
      if (!files.includes(fm[1]) && isProduceGovernedFile(clause, fm.index)) {
        files.push(fm[1]);
      }
    }
    for (const f of files.slice(0, 8)) {
      push(deliverables, "DEL", clause, {
        target: f,
        quantity: extractQuantity(clause),
      });
    }
    if (CONSTRAINT_RE.test(clause)) {
      const bm = BUDGET_RE.exec(clause);
      const maxAmount = bm ? Number(bm[1] ?? bm[2] ?? bm[3]) : undefined;
      const onlyTerms = extractOnlyTerms(clause);
      push(constraints, "CON", clause, {
        quantity: extractQuantity(clause),
        ...(maxAmount !== undefined ? { maxAmount } : {}),
        ...(onlyTerms ? { onlyTerms } : {}),
      });
    }
    // Obligations are imperative clauses: the clause must LEAD with a
    // work verb (after list/filler prefixes). A noun-phrase clause that
    // merely contains a verb-shaped word ("f3 r1 test mission",
    // "the test suite") is objective material, never a requirement —
    // conservative incompleteness beats invention.
    let rest = clause;
    for (let i = 0; i < 4 && LEADING_FILLER_RE.test(rest); i++) {
      rest = rest.replace(LEADING_FILLER_RE, "").trim();
    }
    // A clause whose only work content is produce-verb + file target is
    // already fully represented by its DEL row ("create report.md") —
    // duplicating it as an obligation adds noise, not coverage. An
    // additional non-produce work verb in the same clause is separate
    // mandatory work and mints an obligation on its own.
    const beyondProduce = clause
      .replace(PRODUCE_VERB_RE, " ")
      .replace(FILE_RE, " ");
    const delOnly = files.length > 0 && !OBLIGATION_VERB_RE.test(beyondProduce);
    if (!delOnly && OBLIGATION_VERB_RE.test(rest)) {
      const first = /^[\p{L}\p{N}_]+/u.exec(rest);
      if (
        first &&
        OBLIGATION_VERB_RE.test(rest.slice(0, first[0].length + 8)) &&
        /^(?:research|analy|assess|evaluat|review|study|investigat|survey|compar|benchmark|contrast|propos|recommend|suggest|deriv|identif|fetch|retriev|collect|gather|download|scrape|extract|creat|writ|build|develop|design|implement|produc|generat|draft|save|export|render|comput|calculat|measure|quantif|estimat|forecast|plot|draw|chart|graph|summar|digest|test|verif|validat|check|monitor|track|translat|deploy|publish|list|rank|score|select|choose|screen|nghiên|phân|đánh|xem|khảo|so|đối|đề|xác|lấy|tải|thu|tra|tìm|tạo|viết|soạn|lưu|xuất|xây|phát|thiết|triển|tính|ước|dự|vẽ|tóm|kiểm|theo|giám|dịch|liệt|xếp|chọn)/iu.test(rest)
      ) {
        push(obligations, "OBL", clause, {
          quantity: extractQuantity(clause),
        });
        continue;
      }
    }
    // Unclassifiable clauses are objective-only — never invent a
    // requirement from them.
  }

  const contractBase = {
    objective: clauses[0]?.slice(0, 400) ?? raw.slice(0, 400),
    obligations,
    deliverables,
    constraints,
    prohibitions,
    deadline,
    delivery_intent: detectTelegramDeliveryIntent(raw),
    output_language: detectOutputLanguage(raw),
  };
  const contractDigest = createHash("sha256")
    .update(JSON.stringify(canonicalizeForDigest(contractBase)))
    .digest("hex")
    .slice(0, 32);
  return { ...contractBase, contractDigest };
}

function canonicalizeForDigest(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalizeForDigest);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = canonicalizeForDigest((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

/** All mandatory requirement rows — obligations + deliverables — plus
 *  constraints/prohibitions for constraint validation. */
export function contractRequirements(contract: GoalContract): GoalRequirement[] {
  return [
    ...contract.obligations,
    ...contract.deliverables,
    ...contract.constraints,
    ...contract.prohibitions,
  ];
}
