/**
 * output-language.ts — canonical PAIR-owned output-language contract.
 *
 * The operator-facing output language is an authority derived ONLY from
 * the effective operator goal — never from planner metadata, executor
 * prose, or any persisted value that cannot be re-derived. It is
 * stamped onto the canonical delivery task (`metadata.pair_output_language`)
 * at the plan-dataflow reconcile seam so the pinned plan digest covers
 * it, and it is re-derived from the goal at every assert boundary and
 * at the delivery-contract gate (the gate re-derives — a forged or
 * tampered stamp can never move runtime authority).
 *
 * Authority order (deterministic, documented):
 *  1. GOAL_DIRECTIVE — an explicit operator language directive in the
 *     goal ("bằng tiếng việt", "in English", "日本語で", …) wins
 *     outright. This is the strongest authority: the operator asked for
 *     the output language by name.
 *  2. GOAL_LANGUAGE — the goal's own dominant language, detected
 *     deterministically (script markers + bounded keyword scoring): an
 *     operator writing Vietnamese gets Vietnamese deliverables without
 *     having to say so.
 *  3. UNDETERMINED — neither applies: `code` is null. No authority is
 *     invented; the verification gate then has nothing canonical to
 *     check, and the composed-text instruction falls back to the
 *     advisory "same language as the goal" phrasing.
 *
 * Detection is deliberately narrow (vi / en / ja — the operator base)
 * and deterministic: same input, same verdict, replay-verifiable. A
 * deliverable that classifies confidently to a DIFFERENT language than
 * the canonical code is a fail-closed violation; one that does not
 * classify confidently enough cannot prove a mismatch and passes with
 * `detected: null` evidence (documented — never silently treated as a
 * match).
 *
 * Language scope (mandate E): only the final operator-facing
 * deliverable is language-bound — the manifested textual artifacts
 * (FILES) and the canonical composed payload (TEXT). Intermediate task
 * outputs may be any language.
 */

/** The PAIR-reserved task-metadata key carrying the canonical stamp. */
export const PAIR_OUTPUT_LANGUAGE_KEY = "pair_output_language";

/** The canonical TEXT-mode payload artifact: the delivery task composes
 *  the operator-facing report into this file; the minted TDR's text is
 *  exactly its content — an execution acknowledgement ("DONE") is never
 *  the deliverable. */
export const DELIVERY_TEXT_ARTIFACT = "outbox/report.txt";

/** Manifested artifact extensions treated as operator-facing text for
 *  language verification (FILES mode "where applicable"). Binary or
 *  data-ish names not in this set are never language-checked. */
export const TEXT_DELIVERABLE_EXTS = new Set([
  ".txt", ".md", ".html", ".htm", ".rst", ".log",
]);

export interface OutputLanguage {
  /** ISO code of the canonical output language; null = undetermined. */
  code: string | null;
  /** Why this code was selected — replay-verifiable provenance. */
  authority: "GOAL_DIRECTIVE" | "GOAL_LANGUAGE" | "UNDETERMINED";
  /** Deterministic evidence: the matched directive phrase, or the
   *  detector that produced the code. */
  evidence: Record<string, unknown>;
}

const LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ja: "Japanese",
};

/** Human rendering used inside canonical instructions. */
export function languagePhrase(code: string | null | undefined): string {
  if (!code) return "the same language as the operator's goal";
  return `${LANGUAGE_NAMES[code] ?? code} (${code})`;
}

/* ------------------------- directive parsing -------------------------- */

/** Explicit operator language directives. A mention mints output-language
 *  authority ONLY when it binds to an output/deliverable clause (R1.4) —
 *  a language naming the operator's SOURCE material never does. */
const LANGUAGE_DIRECTIVES: Array<[RegExp, string]> = [
  // Vietnamese frames — "bằng tiếng việt", "báo cáo tiếng việt", "viết tiếng việt".
  [/(?:bằng|bang)\s+tiếng\s+(?:việt|viet)|tiếng\s+việt|tieng\s+viet/iu, "vi"],
  [/\b(?:in|into)\s+vietnamese\b|\bvietnamese\s+language\b/iu, "vi"],
  // English frames — "bằng tiếng anh", "in English", "English language".
  [/(?:bằng|bang)\s+tiếng\s+anh|tiếng\s+anh|tieng\s+anh/iu, "en"],
  [/\b(?:in|into)\s+english\b|\benglish\s+language\b/iu, "en"],
  // Japanese frames — "bằng tiếng nhật", "in Japanese", 日本語(で).
  [/(?:bằng|bang)\s+tiếng\s+nhật|tiếng\s+nhật|tieng\s+nhat/iu, "ja"],
  [/\b(?:in|into)\s+japanese\b|\bjapanese\s+language\b/iu, "ja"],
  [/英語/, "en"],
  [/日本語/, "ja"],
];

/** R1.4 — bounded deterministic grammar binding a language mention to
 *  an OUTPUT clause. The markers are scanned inside a fixed lookback
 *  window before each mention; the marker NEAREST the mention decides
 *  its scope. Output verbs/deliverable nouns: the language describes
 *  what the operator RECEIVES. Source verbs/nouns (read/sources/input/
 *  đọc/nguồn/tài liệu/…): the language describes the INPUT material —
 *  it mints nothing. A mention with no markers at all is a bare
 *  directive and counts as output-scoped. Two different output-scoped
 *  codes → explicit conflict → UNDETERMINED (never regex-order pick). */
const DIRECTIVE_LOOKBACK = 160;
const OUTPUT_MARKERS: RegExp[] = [
  /\b(?:write|writes|writing|compose|composing|summari[sz]e[sd]?|summarizing|respond|response|produce|produces|producing|answers?|translat(?:e|es|ing|ion)|convert(?:s|ed|ing)?|repl(?:y|ies|ied|ying)|deliver(?:able|ables|y|ing)?|outputs?|final|report|reports)\b/giu,
  /(?<![\p{L}\p{N}])(?:viết|viet|soạn|soan|tóm\s+tắt|tom\s+tat|trả\s+lời|tra\s+loi|tạo|tao|gửi|gui|báo\s+cáo|bao\s+cao|kết\s+quả|ket\s+qua|xuất|xuat)(?![\p{L}\p{N}])/iu,
];
const SOURCE_MARKERS: RegExp[] = [
  /\b(?:read|reads|reading|sources?|inputs?|materials?|documents?|references?|from|based\s+on)\b/giu,
  /(?<![\p{L}\p{N}])(?:đọc|doc|nguồn|nguon|tài\s+liệu|tai\s+lieu|tham\s+khảo|tham\s+khao)(?![\p{L}\p{N}])/iu,
];

const lastMarkerIndex = (text: string, markers: RegExp[]): number => {
  let best = -1;
  for (const re of markers) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) best = Math.max(best, m.index);
  }
  return best;
};

/** Collect every language mention; for each, decide whether it binds to
 *  an output clause. Overlapping mentions are deduped by span — the
 *  earliest (and longest-covering) wins. */
function collectOutputLanguageMentions(
  text: string,
): Array<{ code: string; directive: string; index: number }> {
  const mentions: Array<{ code: string; directive: string; index: number; end: number }> = [];
  for (const [re, code] of LANGUAGE_DIRECTIVES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      mentions.push({ code, directive: m[0].trim(), index: m.index, end: m.index + m[0].length });
    }
  }
  mentions.sort((a, b) => a.index - b.index || b.end - a.end);
  const deduped: typeof mentions = [];
  for (const mn of mentions) {
    // A mention starting inside an earlier one's span is the same
    // utterance matched twice — keep the earliest/longest.
    if (deduped.length && mn.index < deduped[deduped.length - 1].end) continue;
    deduped.push(mn);
  }
  const out: Array<{ code: string; directive: string; index: number }> = [];
  for (const mn of deduped) {
    const window = text.slice(Math.max(0, mn.index - DIRECTIVE_LOOKBACK), mn.index);
    const lastOut = lastMarkerIndex(window, OUTPUT_MARKERS);
    const lastSrc = lastMarkerIndex(window, SOURCE_MARKERS);
    // Nearest marker wins: a source marker strictly closer to the
    // mention means the language describes INPUT material — skip it.
    if (lastSrc >= 0 && lastSrc > lastOut) continue;
    out.push({ code: mn.code, directive: mn.directive, index: mn.index });
  }
  return out;
}

/* ------------------------- language classifier ------------------------ */

/** Vietnamese-specific letters: ă â đ ê ô ơ ư plus every precomposed
 *  tone-marked Vietnamese vowel (U+1EA0–U+1EF9). A handful of them in a
 *  text is a strong vi signal — far stronger than unaccented keywords. */
const VI_DIACRITICS_RE =
  /[ĂăÂâĐđÊêÔôƠơƯưẠ-ỹ]/gu;

const VI_WORDS = [
  "và", "của", "là", "được", "trong", "với", "các", "từ", "đã",
  "không", "những", "khi", "cho", "này", "đó", "một", "nhất", "ngày",
  "giá", "vàng", "viết", "gửi", "đến", "đọc", "sau", "trước", "năm",
  "tuần", "qua", "tỷ", "mới", "tóm", "đầu", "tư", "xu", "hướng",
  "tăng", "giảm", "nên", "cũng", "vẫn", "đang", "sẽ", "rất",
];

/** Unaccented Vietnamese bigrams — unambiguous against English (each is
 *  two words; one lone token like "bao cao" could be a name). */
const VI_PHRASES = [
  "phan tich", "tong hop", "bao cao", "gia vang", "du lieu",
  "tin tuc", "thu thap", "nhiem vu", "noi dung", "gui den",
  "viet bao", "tom tat", "moi nhat", "hom nay", "gia ca",
];

const EN_WORDS = [
  "the", "and", "of", "to", "in", "for", "on", "with", "at", "from",
  "by", "is", "are", "was", "were", "be", "have", "has", "or", "this",
  "that", "it", "its", "into", "an", "a", "market", "price", "report",
  "analysis", "gold", "send", "write", "read", "collect", "gather",
  "latest", "news", "daily", "weekly", "today", "deliver", "summarize",
  "compose", "produce", "make", "build", "create", "show", "find",
  "get", "use", "then",
];

const BOUNDARY = (tok: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\p{M}_])`,
    "giu",
  );

const VI_WORD_RES = VI_WORDS.map(BOUNDARY);
const VI_PHRASE_RES = VI_PHRASES.map(BOUNDARY);
const EN_WORD_RES = EN_WORDS.map(BOUNDARY);

const countHits = (text: string, res: RegExp[]): number =>
  res.reduce((n, re) => n + (text.match(re) ?? []).length, 0);

/**
 * Deterministic content classifier over the supported operator-facing
 * languages. Returns "vi" | "en" | "ja" when the evidence is confident,
 * else null. Confident means: a unique script marker (kana → ja), OR
 * ≥3 weighted keyword/diacritic hits with a strict winner.
 */
export function classifyTextLanguage(text: unknown): string | null {
  const t = String(text ?? "").normalize("NFC").slice(0, 64 * 1024);
  if (!t.trim()) return null;
  // Hiragana/katakana — unambiguous Japanese script.
  if (/[぀-ヿ]/u.test(t)) return "ja";
  const viDiacritics = (t.match(VI_DIACRITICS_RE) ?? []).length;
  const vi = viDiacritics * 2 + countHits(t, VI_WORD_RES) + countHits(t, VI_PHRASE_RES) * 2;
  const en = countHits(t, EN_WORD_RES);
  const best = Math.max(vi, en);
  if (best < 3) return null;
  if (vi === best && vi > en) return "vi";
  if (en === best && en > vi) return "en";
  return null;
}

/* ------------------------- canonical contract ------------------------- */

/**
 * Derive the canonical output-language authority from the effective
 * operator goal. Pure + deterministic — the same goal always yields the
 * same contract, at plan reconcile, at every assert replay, and at the
 * delivery-contract gate.
 */
export function detectOutputLanguage(goal: unknown): OutputLanguage {
  const text = String(goal ?? "").normalize("NFC").slice(0, 4096);
  // R1.4 — only OUTPUT-SCOPED language mentions mint authority. A
  // language naming source/input material is skipped; genuinely
  // conflicting output directives resolve to explicit UNDETERMINED —
  // never a regex-order pick.
  const directives = collectOutputLanguageMentions(text);
  const codes = [...new Set(directives.map((d) => d.code))];
  if (codes.length === 1) {
    return {
      code: codes[0],
      authority: "GOAL_DIRECTIVE",
      evidence: {
        directive: directives[0].directive,
        scope: "output",
        ...(directives.length > 1 ? { mentions: directives.length } : {}),
      },
    };
  }
  if (codes.length > 1) {
    return {
      code: null,
      authority: "UNDETERMINED",
      evidence: {
        detector: "conflicting_output_directives",
        codes,
        directives: directives.map((d) => d.directive),
      },
    };
  }
  const detected = classifyTextLanguage(text);
  if (detected) {
    return {
      code: detected,
      authority: "GOAL_LANGUAGE",
      evidence: { detector: "dominant_goal_language" },
    };
  }
  return {
    code: null,
    authority: "UNDETERMINED",
    evidence: { detector: "none" },
  };
}

/**
 * Language gate predicate: does `text` satisfy the canonical code?
 *  - no canonical code → nothing to satisfy (ok).
 *  - detected === code → ok.
 *  - detected === null → ok with detected:null evidence — content too
 *    short/ambiguous to prove a mismatch; documented non-violation.
 *  - detected !== code → fail-closed violation.
 */
export function verifyOutputLanguageContent(
  text: unknown,
  expected: string | null | undefined,
): { ok: boolean; detected: string | null; expected: string | null } {
  const code = expected ?? null;
  if (!code) return { ok: true, detected: null, expected: null };
  const detected = classifyTextLanguage(text);
  if (detected === null || detected === code) {
    return { ok: true, detected, expected: code };
  }
  return { ok: false, detected, expected: code };
}

/** Lowercased extension check for the FILES-mode language gate. */
export function isTextDeliverableName(name: unknown): boolean {
  const s = String(name ?? "").toLowerCase();
  const i = s.lastIndexOf(".");
  return i >= 0 && TEXT_DELIVERABLE_EXTS.has(s.slice(i));
}
