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
  /** For budget-like constraints: the operator's ceiling amount. */
  maxAmount?: number;
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
    for (const seg of h.split(
      /\s*(?:,|(?:\s+)(?:and then|then|sau đó|rồi|và|and)\s+)/iu,
    )) {
      const s = seg.trim();
      if (s) clauses.push(s);
    }
  }
  return clauses.slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* classification vocabulary (bounded EN + VI, no classifiers)         */
/* ------------------------------------------------------------------ */

const PROHIBITION_RE =
  /\b(?:do not|don't|do n't|never|must not|shall not|may not|cannot|không được|không đc|đừng|cấm|không nên|tránh)\b/iu;
const PROHIBITED_VERB_STRIP =
  /^(?:use|using|send|sending|run|running|deliver|execute|post|include|access|call|invoke|touch|dùng|sử dụng|gửi|chạy|đăng|dùng tới)\s+/iu;

const DEADLINE_RE =
  /\bdeadline\b|\bdue\b|\bhạn\b|\btrước ngày\b|\btrước\b.{0,12}\b(?:giờ|ngày)\b|\bby\s+\d{1,2}[/-]\d{1,2}/iu;

const CONSTRAINT_RE =
  /\bbudget\b|\bngân sách\b|\btối đa\b|\bkhông quá\b|\bonly\b|\bchỉ\b|\bchỉ được\b|\bngoại trừ\b|\bexcept\b|\bin (?:english|vietnamese|spanish|french|japanese)\b|\bbằng tiếng\b|\b(?:max|maximum|up to|at most)\s+\d|\b(?:<=|≤)\s*\$?\s*\d/i;

const BUDGET_RE =
  /\bbudget\b[^\d]{0,20}(\d+(?:\.\d+)?)|\bngân sách\b[^\d]{0,20}(\d+(?:\.\d+)?)|\$(\d+(?:\.\d+)?)\s*(?:budget|max|tối đa)/i;

const FILE_RE = /\b([\w][\w.-]*\.(?:md|txt|json|csv|pdf|html?|png|jpe?g|webp|svg|ts|tsx|js|mjs|py|ipynb|docx?|xlsx|zip|mq[45]))\b/gi;

const PRODUCE_VERB_RE =
  /\b(?:create|write|produce|generate|save|draft|export|render|emit|build|tạo|viết|soạn|lưu|xuất|sinh|render)/iu;

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
  "đăng", "bất", "kỳ", "gì",
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

function prohibitionTerms(clause: string): string[] {
  const rest = clause.replace(PROHIBITION_RE, " ").trim();
  const terms: string[] = [];
  for (const m of rest.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || PROHIBITION_STOPWORDS.has(w)) continue;
    if (!terms.includes(w)) terms.push(w);
  }
  return terms.slice(0, 8);
}

/** Extract the Goal Contract — the deterministic, append-only projection
 *  of the raw operator goal. Same input → same contract, always. */
export function extractGoalContract(goal: string): GoalContract {
  const raw = String(goal ?? "");
  const clauses = splitClauses(raw);
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

  for (const clause of clauses) {
    // Prohibition outranks everything — a clause that forbids also naming
    // a file or a verb must not mint a deliverable/obligation.
    if (PROHIBITION_RE.test(clause)) {
      push(prohibitions, "PRO", clause, {
        terms: prohibitionTerms(clause),
      });
      continue;
    }
    if (!deadline && DEADLINE_RE.test(clause)) {
      deadline = { id: "DDL_001", text: clause.slice(0, 500) };
      continue;
    }
    // An explicit telegram-delivery clause is governed by the existing
    // intent authority — it mints neither obligation nor deliverable.
    if (detectTelegramDeliveryIntent(clause).requested) continue;
    const files: string[] = [];
    if (PRODUCE_VERB_RE.test(clause)) {
      FILE_RE.lastIndex = 0;
      let fm: RegExpExecArray | null;
      while ((fm = FILE_RE.exec(clause)) !== null) {
        if (!files.includes(fm[1])) files.push(fm[1]);
      }
    }
    if (files.length) {
      for (const f of files.slice(0, 8)) {
        push(deliverables, "DEL", clause, {
          target: f,
          quantity: extractQuantity(clause),
        });
      }
      continue;
    }
    if (CONSTRAINT_RE.test(clause)) {
      const bm = BUDGET_RE.exec(clause);
      const maxAmount = bm ? Number(bm[1] ?? bm[2] ?? bm[3]) : undefined;
      push(constraints, "CON", clause, {
        quantity: extractQuantity(clause),
        ...(maxAmount !== undefined ? { maxAmount } : {}),
      });
      continue;
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
    if (OBLIGATION_VERB_RE.test(rest)) {
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
