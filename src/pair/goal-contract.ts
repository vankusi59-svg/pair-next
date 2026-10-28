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
import { IntegrityError } from "./errors.js";
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
  /** For prohibitions: the connector-delimited object phrases the plan
   *  must avoid (e.g. "hứa lợi nhuận", "tư vấn tài chính"). This is the
   *  semantic matching unit for enforcement — a plan violates when it
   *  invokes the phrase, not when it merely contains a single term. */
  phrases?: string[];
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
  /** P18.5 F10 — dimensioned operator ceiling: the amount plus the
   *  verification class it is bound to. Money ceilings check declared
   *  task amounts; task-count ceilings check the plan's task count;
   *  object-count ceilings check numbers bound to the same unit noun in
   *  task instructions (and declared produced artifacts for file-like
   *  units). A ceiling with no verifiable dimension is never minted —
   *  the constraint stays PRESERVED rather than fabricating a bound. */
  ceiling?: {
    amount: number;
    kind: "money" | "task-count" | "object-count";
    unit?: string;
  };
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
/* authority boundary — provenance, never formatting                   */
/* ------------------------------------------------------------------ */

/** A delegated mission carries TWO texts with different authority:
 *
 *  `goal` — the committed bound-mission envelope `boundMissionGoal`
 *  emits: a `[BUSINESS … | DEPT … | AGENT …]` provenance header, then
 *  the operator goal, then appended machine sections such as
 *  `[AGENT CONTEXT — last N outcomes]` followed by history bullets
 *  (`- [delegated] …`). The whole envelope is persisted as
 *  `mission.goal`, reaches the planner prompt verbatim as supporting
 *  context, and is digest-bound by `delegated_goal_digest`.
 *
 *  `operator_goal` — the trusted operator request, provenance-bound at
 *  the minting seam: the bound work item's canonical `goal` field
 *  (derived inside `startBoundMission` from the loaded `work_item`
 *  row, never caller-supplied). Only this text may mint obligations,
 *  deliverables, constraints, prohibitions, network-source
 *  authorization, Telegram delivery intent, or output-language
 *  authority. Agent history is informational — it can never grant or
 *  modify those authorities.
 *
 *  Live incident behind this boundary: an `[AGENT CONTEXT]` bullet
 *  leading with a work verb minted a fabricated OBL requirement →
 *  coverage failed closed (FAIL_CLOSED_PLAN_INCOMPLETE), the planner
 *  run exhausted, the objective recorded INTEGRITY_FAULT. The earlier
 *  fix inferred the boundary from Markdown formatting; audit R1/F1
 *  rejected that — format is never evidence of authority. The boundary
 *  here is recorded provenance, not parsing. */
export function operatorGoalOf(
  source:
    | string
    | { goal?: unknown; operator_goal?: unknown }
    | null
    | undefined,
): string {
  if (typeof source === "string") return source;
  const og = source?.operator_goal;
  if (typeof og === "string" && og.trim() !== "") return og;
  // No recorded provenance → the committed goal itself IS the operator
  // request (direct submissions, legacy rows minted before the field
  // existed). This is authority-of-record fallback — never a widening:
  // a bound mission always carries the explicit pin.
  return String(source?.goal ?? "");
}

/** The mission's operator-goal authority text, resolved by PROVENANCE
 *  (never by parsing the committed goal) — the ONE canonical seam shared
 *  by MissionRuntime's planner calls and the governed async replan
 *  generation driver:
 *    1. bound missions (bound_open_id set) — the canonical chain
 *       work_open_binding → work_item.goal is validated on EVERY
 *       resolution; a pinned `operator_goal` is the immutable snapshot
 *       of that goal taken at mint (identical by construction — any
 *       divergence fails closed), never a bypass around provenance.
 *       Missing/mismatched binding, missing or goal-less work item, or
 *       pin divergence all FAIL CLOSED: unrecoverable canonical
 *       authority can never silently widen to the enriched envelope;
 *    2. legacy bound rows minted before the field — same chain, the
 *       canonical work item goal IS the recovered snapshot;
 *    3. direct missions (no binding) — the persisted `operator_goal`
 *       pin (preview/confirm path) or, for pre-R1 rows, `goal` itself.
 *  This text — and only this text — may mint contract requirements,
 *  network authorization, Telegram delivery intent, or output
 *  language. The enriched envelope stays informational. */
export function missionOperatorGoalOf(
  store: {
    tryGet: (
      entityType: string,
      entityId: string,
    ) => (Record<string, unknown> & { version: number }) | null;
  },
  mission: Record<string, unknown>,
): string {
  const og = mission.operator_goal;
  const openId = mission.bound_open_id;
  if (typeof openId === "string" && openId !== "") {
    const binding = store.tryGet(
      "work_open_binding", openId,
    ) as Record<string, unknown> | null;
    if (
      !binding ||
      String(binding.mission_id ?? "") !== String(mission.mission_id ?? "")
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_BOUND_GOAL_PROVENANCE",
        `bound mission ${String(mission.mission_id)}: work_open_binding ${openId} missing or mission-mismatched`,
      );
    }
    const wi = store.tryGet(
      "work_item", String(binding.work_item_id ?? ""),
    ) as Record<string, unknown> | null;
    if (wi?.goal == null || String(wi.goal).trim() === "") {
      throw new IntegrityError(
        "FAIL_CLOSED_BOUND_GOAL_PROVENANCE",
        `bound mission ${String(mission.mission_id)}: work_item ${String(binding.work_item_id ?? "")} missing or goal-less`,
      );
    }
    const canonical = String(wi.goal);
    if (typeof og === "string" && og.trim() !== "") {
      if (og !== canonical) {
        throw new IntegrityError(
          "FAIL_CLOSED_BOUND_GOAL_PROVENANCE",
          `bound mission ${String(mission.mission_id)}: pinned operator_goal diverges from work_item.goal`,
        );
      }
      return og;
    }
    // Legacy pre-R1 bound row (no pinned field): recover the snapshot.
    return canonical;
  }
  // Direct mission — no bound provenance to validate. A pinned
  // operator_goal (persisted through preview/confirm) is authoritative;
  // pre-R1 direct rows derive authority from the operator-submitted goal.
  if (typeof og === "string" && og.trim() !== "") return og;
  return String(mission.goal ?? "");
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
    /* Semantic Planning V1 (C′) — a comma inside a grouped-thousands
       number ("1,000 subscribers") is numeric punctuation, never a
       clause separator. Bounded guard: digit before + exactly-3-digit
       group after. */
    if (
      m[0].includes(",") &&
      /\d$/.test(seg.slice(0, m.index)) &&
      /^\d{3}\b/.test(seg.slice(m.index + m[0].length))
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
  `(?<![\\p{L}\\p{N}])(?:do not|don't|do n't|never|must not|shall not|may not|cannot|không được|không đc|không nên|đừng|cấm|tránh|không(?=\\s+(?:${ALL_ACTION_FORMS})(?![\\p{L}\\p{N}])))` +
    /* Semantic Planning V1 (C′) — "without X" bans X inside the goal:
       bounded to a following bounded noun-phrase so an innocuous
       "a world without borders" idiom is read the same way — as an
       exclusion the operator stated. VI equivalents keep structural
       action evidence (`không` needs a forbidden action after it). */
    `|(?<![\\p{L}\\p{N}])without(?=\\s+[\\p{L}\\p{N}])(?![\\p{L}\\p{N}])` +
    /* K″ review F1 — `không cần` means "no need to" (relief), not
       "must not": gating it on a following ACTION FORM keeps `không
       cần dùng martingale` a ban while `không cần thiết` (unnecessary)
       and `không cần kiểm tra lại` stop minting term-bans on the
       goal's own content words. `mà không`/`và không` keep the
       any-word tail (pre-existing semantics). */
    `|(?<![\\p{L}\\p{N}])(?:mà không|và không|không cần(?=\\s+(?:${ALL_ACTION_FORMS})(?![\\p{L}\\p{N}])))(?=\\s+[\\p{L}\\p{N}])(?![\\p{L}\\p{N}])`,
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

/* K″ audit — every boundary here is a unicode lookaround, never `\b`:
 *  `giờ` ends on the non-ASCII vowel `ờ` where ASCII `\b` can never
 *  fire, so "trước 10 giờ" / "trong vòng 30 giờ" minted no deadline
 *  row AND leaked `10`/`30` into the bare-quantity scan. */
const DEADLINE_RE =
  /(?<![\p{L}\p{N}])deadline(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])due(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])hạn(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trước ngày(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trước(?![\p{L}\p{N}]).{0,12}(?<![\p{L}\p{N}])(?:giờ|ngày)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])by\s+\d{1,2}[/-]\d{1,2}|(?<![\p{L}\p{N}])within\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:days?|weeks?|months?|hours?|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])in\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:days?|weeks?|months?|hours?)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trong\s+vòng\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:ngày|tuần|tháng|giờ|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trong\s+khoảng\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:ngày|tuần|tháng|giờ|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trong\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:ngày|tuần|tháng|giờ|phút|giây)(?![\p{L}\p{N}])/iu;

/* K″ audit — `không quá` (ends `á`), bare `chỉ` (`ỉ`) and `ngoại trừ`
 *  (`ừ`) were dead under ASCII `\b`: "không quá 50 USD" minted no
 *  constraint and fell through to the preserved-obligation backstop —
 *  a ceiling inverting into a floor. Unicode lookarounds throughout. */
const CONSTRAINT_RE =
  /(?<![\p{L}\p{N}])budget(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ngân sách(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])tối đa(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])không quá(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])only(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])chỉ(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])chỉ được(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ngoại trừ(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])except(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])in (?:english|vietnamese|spanish|french|japanese)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])bằng tiếng(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:max|maximum|up to|at most|no more than|not more than|nhiều nhất|không hơn|không vượt quá)\s+\d|(?<![\p{L}\p{N}])(?:<=|≤)\s*\$?\s*\d/iu;

const BUDGET_RE =
  /\bbudget\b[^\d]{0,20}(\d+(?:\.\d+)?)|\bngân sách\b[^\d]{0,20}(\d+(?:\.\d+)?)|\$(\d+(?:\.\d+)?)\s*(?:budget|max|tối đa)/i;

/* P18.5 F10 — dimensioned ceilings. `maxAmount`/BUDGET_RE only sees the
 *  literal "budget" phrasing, so "không quá 50 USD" / "at most 5
 *  outputs" minted constraint rows that were recorded but never
 *  enforceable. CEILING_RE captures EN/VI ceiling markers + grouped
 *  numbers + an optional unit token; the unit class decides which
 *  deterministic evidence may check the bound. Unicode lookarounds —
 *  VI markers end on non-ASCII edges (`đa`, `á`, `t`) where `\b` dies.
 *  One optional gap word absorbs forms like "tối đa tháng 500 đơn" so
 *  the amount binds to the trailing object noun, not the gap word. */
const CEILING_MARKER_ALT =
  `at most|no more than|not more than|up to|max(?:imum)?|không quá|` +
  `không vượt quá|nhiều nhất|không hơn|tối đa|<=|≤`;
const CEILING_MARKER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CEILING_MARKER_ALT})(?![\\p{L}\\p{N}])`,
  "iu",
);
const CEILING_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CEILING_MARKER_ALT})\\s*` +
    `(?:([\\$€£]|usd|vnd|đồng|dollars?|euros?|pounds?)\\s*)?` +
    `(?:(\\p{L}+)\\s+)?` +
    `(\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:\\.\\d+)?)` +
    `(?:\\s+([\\p{L}$€£][\\p{L}$€£]*(?:\\s+[\\p{L}$€£][\\p{L}$€£]*)?))?`,
  "iu",
);

/** Money units → the ceiling is enforceable against declared task
 *  amounts via the same-unit amount scan (no FX conversion). */
const CEILING_UNIT_MONEY = new Set([
  "$", "€", "£", "usd", "dollar", "dollars", "vnd", "đồng", "đô",
  "đô la", "euro", "euros",
]);
/** Task-count units → enforceable against the plan's own task count. */
const CEILING_UNIT_TASKS = new Set([
  "task", "tasks", "step", "steps", "stage", "stages", "mission",
  "missions", "tác vụ", "nhiệm vụ", "công việc", "việc", "bước",
  "giai đoạn",
]);
/** Units that are NEVER count evidence — a cap on a duration,
 *  frequency, percentage, or version is schedule/context, not an
 *  enforceable object count. */
const CEILING_UNIT_NEVER = new Set([
  "day", "days", "ngày", "hour", "hours", "giờ", "minute", "minutes",
  "phút", "second", "seconds", "giây", "week", "weeks", "tuần",
  "month", "months", "tháng", "quý", "quarter", "quarters", "year",
  "years", "năm", "lần", "times", "mỗi", "per", "%", "phần trăm",
  "percent", "version", "versions", "phiên bản",
]);

function extractCeiling(
  clause: string,
): { amount: number; kind: "money" | "task-count" | "object-count"; unit?: string } | undefined {
  const m = CEILING_RE.exec(clause);
  if (!m) return undefined;
  const amount = parseNum(m[3]);
  if (!Number.isFinite(amount)) return undefined;
  const pre = (m[1] ?? m[2]) ? String(m[1] ?? m[2]).toLowerCase() : undefined;
  let unitRaw = (m[4] ?? "").trim().toLowerCase();
  // A trailing multiword capture stops at function words — "50 USD mỗi
  //  tháng" binds `USD`, never `usd mỗi`; "500 đơn hàng" keeps both.
  if (unitRaw.includes(" ")) {
    const parts = unitRaw.split(/\s+/);
    const cut = parts.findIndex((w) => CEILING_UNIT_STOP.has(w));
    if (cut === 0) unitRaw = "";
    else if (cut > 0) unitRaw = parts.slice(0, cut).join(" ");
  }
  if (unitRaw && CEILING_UNIT_STOP.has(unitRaw)) unitRaw = "";
  // A currency before the number types the bound regardless of what
  // word follows it ("max $500 for hosting").
  if (pre && CEILING_UNIT_MONEY.has(pre)) {
    return { amount, kind: "money", unit: pre };
  }
  if (!unitRaw) return undefined;
  if (CEILING_UNIT_MONEY.has(unitRaw)) {
    return { amount, kind: "money", unit: unitRaw };
  }
  if (CEILING_UNIT_TASKS.has(unitRaw)) {
    return { amount, kind: "task-count", unit: unitRaw };
  }
  if (CEILING_UNIT_NEVER.has(unitRaw)) return undefined;
  return { amount, kind: "object-count", unit: unitRaw };
}

/** Function words that may follow a ceiling number without being the
 *  bounded object — "max $500 for …" / "không quá 50 USD mỗi tháng". */
const CEILING_UNIT_STOP = new Set([
  "for", "the", "a", "an", "of", "in", "on", "to", "per", "each",
  "and", "or", "và", "với", "cho", "trong", "của", "mỗi", "tổng",
  "total", "được", "là", "thiết",
]);

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

/** Work verbs that make a clause an obligation. The `deliver` form is
 *  present so a non-telegram "deliver X" clause still mints work —
 *  telegram-delivery clauses are consumed by the intent check above the
 *  obligation scan and never reach it. Boundaries are unicode
 *  lookarounds — JS `\b` is ASCII-only and can never see `đ`/`í`-edged
 *  words (K′ audit: `đạt`/`ít nhất`-led lexemes were dead code). */
const LEADING_FILLER_RE =
  /^(?:please|hãy|xin|first(?:ly)?|also|then|next|finally|lastly|đầu tiên|tiếp(?: theo)?|sau đó|rồi|bây giờ|sau khi|ok(?:ay)?|and|và|\d{1,2}[.)]|[•\-–—*])\s*/iu;

/* Semantic Planning V1 (C′) — outcome/growth verbs: a goal like "Grow
 * the channel by 1,000 subscribers" or "đạt 1.000 người đăng ký" is a
 * genuine operator obligation even though no classical work verb leads
 * it. The class is deliberately bound to OUTCOME verbs only — platform
 * nouns and metric nouns stay object-identity, never obligations
 * themselves. */
const OBLIGATION_VERB_RE =
  /(?<![\p{L}\p{N}])(?:research|analy[sz]e|analyse|assess|evaluat|review|study|investigat|survey|compar|benchmark|contrast|propos|recommend|suggest|deriv|identify|fetch|retriev|collect|gather|download|scrape|extract|creat|writ|build|develop|design|implement|produc|generat|draft|save|export|render|comput|calculat|measure|quantif|estimat|forecast|plot|draw|chart|graph|summar|digest|test|verif|validat|check|monitor|track|translat|deploy|publish|list|rank|score|select|choose|screen|grow|growth|increas|boost|gain|achiev|reach|attain|acquir|attract|earn|improv|expand|scal|rais|drive|deliver(?:ing|ed)?|convert|recruit|onboard|nghiên cứu|phân tích|đánh giá|xem xét|khảo sát|so sánh|đối chiếu|đề xuất|xác định|lấy|tải|thu thập|tra cứu|tìm|tạo|viết|soạn|lưu|xuất|xây|phát triển|thiết kế|triển khai|tính|ước tính|dự báo|vẽ|tóm tắt|kiểm tra|kiểm|theo dõi|giám sát|dịch|liệt kê|xếp hạng|chọn|tăng trưởng|tăng|gia tăng|đạt được|đạt|thu hút|mở rộng|nâng cao|nâng|cải thiện|thúc đẩy|chuyển đổi|tuyển)/iu;

const QUANTITY_MIN_RE =
  /(?<![\p{L}\p{N}])(?:at least|minimum of|min(?:imum)?|no fewer than|ít nhất|tối thiểu|>=|≥)\s*(\d{1,3}(?:[.,]\d{3})+|\d+)/iu;
const QUANTITY_MAX_RE =
  /(?<![\p{L}\p{N}])(?:at most|up to|maximum of|no more than|tối đa|không quá|<=|≤)\s*(\d{1,3}(?:[.,]\d{3})+|\d+)/iu;
const QUANTITY_EXACT_RE =
  /(?<![\p{L}\p{N}])(?:exactly|đúng|chính xác)\s+(\d{1,3}(?:[.,]\d{3})+|\d+)/iu;
/** K′ audit — scheduling phrasing carries numbers that are NEVER
 *  quantity evidence: "within 30 days", "in 2 weeks", "trong vòng 30
 *  ngày", a bare year "…in 2026". Masked before the bare-quantity scan
 *  in both contract extraction and task-side floor comparison so a
 *  deadline can neither mint a phantom floor nor satisfy a real one. */
/* K″ audit — trailing edges are `(?![\p{L}\p{N}])`, never `\b`: `giờ`
 *  ends on `ờ` where ASCII `\b` cannot fire, so `30 giờ` leaked into
 *  the quantity scan on both the contract side (phantom floor) and
 *  the task side (a duration satisfying an unrelated floor). */
/* Date ordinals — `ngày 15`, `tháng 5`, `ngày 15/10` (dd/mm tail),
 * `thứ 6`, `tuần 15`, `quý 3`, `week 15`, `năm 2026`, `day 365` are
 * schedule positions, never quantity floors. Per-unit digit bounds so
 * `tháng 500 đơn` keeps its real 500. */
export const TEMPORAL_NUM_RE =
  /(?:within|in|trong\s+vòng|trong\s+khoảng|trong|trước)\s+\d+(?:\s*[-–]\s*\d+)?\s*(?:days?|weeks?|months?|years?|hours?|ngày|tuần|tháng|giờ|năm|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d+\s*[-–]\s*\d+\s*(?:days?|weeks?|months?|years?|hours?|ngày|tuần|tháng|giờ|năm|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d+\s*[-–]?\s*(?:days?|weeks?|months?|years?|hours?|ngày|tuần|tháng|giờ|năm|phút|giây)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:ngày|day)\s+\d{1,3}(?:\s*[/–-]\s*\d{1,2}(?:\s*[/–-]\s*\d{2,4})?)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:tháng|month)\s+\d{1,2}(?:\s*[/–-]\s*\d{2,4})?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:thứ|tuần|quý|week)\s+\d{1,2}(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])năm\s+\d{1,4}(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d{1,2}[/–-]\d{1,2}(?:[/–-]\d{2,4})?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/giu;
/* Semantic Planning V1 (C′) — grouped-thousand forms: `1,000` (EN) is
 *  unambiguous thousands grouping; VI `1.000` is accepted only with a
 *  VI-unit lookahead so a version/decimals token ("1.000.2") never
 *  mints a quantity. */
const BARE_NUM_RE = /\b(\d{1,3}(?:,\d{3})+|\d{1,6})\b/;
const BARE_NUM_VI_DOT_RE =
  /\b(\d{1,3}(?:\.\d{3})+)(?=\s*(?:người|ngày|tháng|tuần|giờ|đăng ký|đơn|lượt|tài khoản|thành viên|khách|đơn hàng|bài|file|video|sản phẩm|usd|vnd|đồng))\b/iu;

function parseNum(raw: string): number {
  /* Grouped thousands ("1,000"/"1.000") strip separators; a lone decimal
   *  point ("2.5"/"9.99") is a magnitude, not grouping — stripping it
   *  would inflate the bound ×10–100. */
  return /^\d{1,3}([.,]\d{3})+$/.test(raw)
    ? Number(raw.replace(/[.,]/g, ""))
    : Number(raw);
}

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
  "without",
  "nor", "else", "than", "hoặc", "cùng", "với", "của", "cho", "là",
  "trong",
  "các", "những", "một", "mỗi", "vào", "ra", "lên", "xuống", "lại",
  "hết", "còn", "sau", "trước", "giữa", "dưới", "ở", "tại", "về",
  "theo", "như", "tự",
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
    const n = parseNum(exactM[1]);
    q.min = n;
    q.max = n;
  } else {
    if (minM) q.min = parseNum(minM[1]);
    if (maxM) q.max = parseNum(maxM[1]);
    if (q.min === undefined && q.max === undefined) {
      // A bare quantity in a work clause is the operator's stated floor —
      // "propose 3 strategies" means at least 3, never "some". Grouped
      // thousands ("1,000" / VI "1.000 người") resolve to the same floor;
      // the VI dot form must win before bare digits can mint a wrong
      // "1" out of "1.000". Numbers inside deadline/duration/year
      // phrasing are scheduling context — masked so "within 30 days"
      // never mints a floor of 30 (K′ audit).
      const scan = clause.replace(TEMPORAL_NUM_RE, " ");
      const viDot = BARE_NUM_VI_DOT_RE.exec(scan);
      const bare = BARE_NUM_RE.exec(scan);
      if (viDot && (!bare || viDot.index <= bare.index)) {
        q.min = parseNum(viDot[1]);
      } else if (bare) {
        q.min = parseNum(bare[1]);
      }
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
/* K″ follow-up — `chỉ` is now live again (CONSTRAINT_RE edge fixed), so
 *  this extractor must not bind VI auxiliaries/modals as the permitted
 *  value: "chỉ được dùng CSV" must bind `csv`, but "chỉ cần/muốn/là/số/
 *  trong …" binds a function word no task can carry — an onlyTerm minted
 *  on an auxiliary is unsatisfiable by construction (guaranteed fail-
 *  closed). The skip-chain strips licensed auxiliaries; the stop-set
 *  degrades everything else to a harmless PRESERVED constraint. */
const ONLY_VI_RE =
  /(?<![\p{L}\p{N}])chỉ\s+(?:(?:dùng|dụng|được)\s+)*([\p{L}\p{N}_-]+)/iu;
const ONLY_TERM_STOP = new Set([
  "the", "a", "an", "this", "that", "these", "those", "one", "two",
  "for", "to", "in", "on", "at", "of", "with", "by", "as", "be",
  "use", "using", "dùng", "dụng", "if", "when", "than", "then",
  // VI function words — `chỉ <modal|aux|function>` is hedging, never a
  // bounded permitted value (K″ review: chỉ cần/muốn/được/là/số/trong).
  "cần", "muốn", "được", "là", "để", "sẽ", "mới", "vẫn", "có",
  "phải", "nên", "mong", "hỏi", "xem", "số", "thị", "đạo", "trong",
  "với", "cho", "của", "thôi", "hãy", "xin",
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
/** Joiners that separate OBJECT list items inside a prohibition head —
 *  wider than ACTION_CONNECTOR_WORDS because an object list accepts
 *  more joiners than an action-verb bridge: "hứa lợi nhuận HAY tư vấn
 *  tài chính" bans two objects; without `hay` here the head merges
 *  into one unmatchable mega-phrase and the ban fails open. Words
 *  that are also stopwords still split — the joiner check runs before
 *  the stopword filter. */
const OBJECT_LIST_JOINERS = new Set([
  ...ACTION_CONNECTOR_WORDS,
  "hay", "cùng", "cũng", "kèm", "với", "như",
  "nor", "with", "plus", "along",
]);
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
  phrases?: string[];
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
  // Phrase groups split on raw connectors BEFORE stopword filtering —
  // `hoặc/or/and/và` are stopwords too, so filtering first would erase
  // the boundary between "hứa lợi nhuận" and "tư vấn tài chính".
  const groups: string[][] = [[]];
  for (const m of stripped.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase();
    if (OBJECT_LIST_JOINERS.has(w)) {
      groups.push([]);
      continue;
    }
    if (PROHIBITION_STOPWORDS.has(w)) continue;
    if (w.length >= 3 && !terms.includes(w)) terms.push(w);
    if (w.length < 2) continue;
    const group = groups[groups.length - 1];
    if (!group.includes(w)) group.push(w);
  }
  const phrases: string[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    const ph = g.join(" ");
    if (!phrases.includes(ph)) phrases.push(ph);
  }
  return {
    terms: terms.slice(0, 8),
    ...(phrases.length ? { phrases: phrases.slice(0, 8) } : {}),
    ...(classes.length ? { actionClass: classes.slice(0, 4) } : {}),
  };
}

/** A connective left dangling at a clause tail is syntax, not subject —
 *  "Research crypto but do not use leverage" splits at the prohibition
 *  trigger leaving "Research crypto but"; the trailing `but` must be
 *  trimmed before the requirement text is minted or the coverage
 *  anchor scan promotes it to a required (unreachable) subject. */
const TRAILING_CONNECTIVE_RE =
  /[\s,;:–—-]+(?:but|however|nevertheless|nonetheless|yet|though|although|whereas|while|and|or|nor|nhưng|và|hoặc|mà|với|còn|then)\.?\s*$/iu;
function trimTrailingConnective(clause: string): string {
  let s = clause.trim();
  for (let i = 0; i < 3 && TRAILING_CONNECTIVE_RE.test(s); i++) {
    s = s.replace(TRAILING_CONNECTIVE_RE, "").trim();
  }
  return s;
}

/** Extract the Goal Contract — the deterministic, append-only projection
 *  of the text it is handed. Same input → same contract, always.
 *  AUTHORITY BOUNDARY: callers must pass `operatorGoalOf(source)` —
 *  the provenance-bound operator goal — never the enriched envelope.
 *  Every operator-authored clause mints authority here, including
 *  Markdown sections, bullet lists, and bracketed header lines. */
export function extractGoalContract(goal: string): GoalContract {
  const clauses = splitClauses(goal);
  // A prohibition trigger opening mid-clause scopes only its own span —
  // "phân tích EA không dùng martingale" keeps the `phân tích EA`
  // obligation AND mints the `use` prohibition; the trigger must not
  // swallow mandatory work stated earlier in the same clause.
  const expanded: string[] = [];
  for (const c of clauses) {
    const tm = PROHIBITION_RE.exec(c);
    if (tm && tm.index > 0 && /[\p{L}\p{N}]/u.test(c.slice(0, tm.index))) {
      expanded.push(trimTrailingConnective(c.slice(0, tm.index)));
      expanded.push(c.slice(tm.index).trim());
    } else {
      expanded.push(trimTrailingConnective(c));
    }
  }
  const obligations: GoalRequirement[] = [];
  const deliverables: GoalRequirement[] = [];
  const constraints: GoalRequirement[] = [];
  const prohibitions: GoalRequirement[] = [];
  const unclassified: string[] = [];
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
    const ceiling = extractCeiling(clause);
    if (CONSTRAINT_RE.test(clause) || ceiling !== undefined) {
      const bm = BUDGET_RE.exec(clause);
      const maxAmount =
        (bm ? Number(bm[1] ?? bm[2] ?? bm[3]) : undefined) ??
        (ceiling?.kind === "money" ? ceiling.amount : undefined);
      const onlyTerms = extractOnlyTerms(clause);
      const cq = extractQuantity(clause);
      /* F10 — a ceiling-shaped clause can still carry a bare-scan `min`
       *  ("tối đa tháng 500 đơn hàng" → min:500). A ceiling is never a
       *  floor — strip `min` wherever an enforceable ceiling or budget
       *  bound was extracted so recorded quantity metadata cannot
       *  invert the operator's direction. */
      if (
        cq &&
        (ceiling !== undefined ||
          maxAmount !== undefined ||
          CEILING_MARKER_RE.test(clause))
      ) {
        delete cq.min;
      }
      push(constraints, "CON", clause, {
        quantity: cq && (cq.min !== undefined || cq.max !== undefined) ? cq : undefined,
        ...(maxAmount !== undefined ? { maxAmount } : {}),
        ...(ceiling ? { ceiling } : {}),
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
        /^(?:research|analy|assess|evaluat|review|study|investigat|survey|compar|benchmark|contrast|propos|recommend|suggest|deriv|identif|fetch|retriev|collect|gather|download|scrape|extract|creat|writ|build|develop|design|implement|produc|generat|draft|save|export|render|comput|calculat|measure|quantif|estimat|forecast|plot|draw|chart|graph|summar|digest|test|verif|validat|check|monitor|track|translat|deploy|publish|list|rank|score|select|choose|screen|grow|growth|increas|boost|gain|achiev|reach|attain|acquir|attract|earn|improv|expand|scal|rais|drive|deliver|convert|recruit|onboard|nghiên|phân|đánh|xem|khảo|so|đối|đề|xác|lấy|tải|thu|tra|tìm|tạo|viết|soạn|lưu|xuất|xây|phát|thiết|triển|tính|ước|dự|vẽ|tóm|kiểm|theo|giám|dịch|liệt|xếp|chọn|tăng|gia|đạt|thu|mở|nâng|cải|thúc|chuyển|tuyển)/iu.test(rest)
      ) {
        push(obligations, "OBL", clause, {
          quantity: extractQuantity(clause),
        });
        continue;
      }
    }
    // Unclassifiable clauses are objective-only — never invent a
    // requirement from them.
    unclassified.push(clause);
  }

  /* K′ audit — a contract with NO coverable requirement must never be
   *  the silent product of a requirement-shaped goal: "Đạt 1.000 người
   *  đăng ký…" whose verb class went unrecognized used to mint an empty
   *  contract that coverage then vacuously PASSED (fail-open on the
   *  deterministic authority). When nothing at all classified, the
   *  longest unclassified clause CARRYING REQUIREMENT EVIDENCE (a stated
   *  quantity floor or deadline phrase) is preserved verbatim as an
   *  obligation row — the operator's own words become the coverage
   *  target. Markerless unparseable goals keep the baseline
   *  conservative-incompleteness semantics (they mint nothing — no
   *  requirement evidence existed to preserve). */
  if (!obligations.length && !deliverables.length) {
    const shaped = unclassified
      .filter(
        (c) =>
          (c.match(/[\p{L}]{3,}/gu) ?? []).length >= 2 &&
          (extractQuantity(c) !== undefined || DEADLINE_RE.test(c)),
      )
      .sort((a, b) => b.length - a.length)[0];
    /* P18.5 F10 — a constraint-shaped unclassified clause already minted
     *  a verbatim CON row carrying its bound; re-preserving it as an
     *  obligation only double-counts and can trap coverage on a bound
     *  the task could never restate ("tối đa 3 ngày"). Skip those here —
     *  the CON row remains the authoritative record. */
    if (shaped && !CONSTRAINT_RE.test(shaped) && !CEILING_MARKER_RE.test(shaped)) {
      push(obligations, "OBL", shaped, {
        quantity: extractQuantity(shaped),
      });
    }
  }

  const contractBase = {
    objective: clauses[0]?.slice(0, 400) ?? goal.slice(0, 400),
    obligations,
    deliverables,
    constraints,
    prohibitions,
    deadline,
    delivery_intent: detectTelegramDeliveryIntent(goal),
    output_language: detectOutputLanguage(goal),
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
