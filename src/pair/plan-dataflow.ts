/**
 * plan-dataflow.ts — canonical deterministic plan data-flow authority.
 *
 * The LLM planner emits task DAGs whose `depends_on` edges are untrusted:
 * a task that consumes an artifact produced by another task MUST declare
 * that producer in `depends_on`, and the DAG itself cannot see the flow of
 * files through the workspace. This module derives a bounded, normalized
 * artifact I/O model per task and reconciles consumed artifacts against
 * producers BEFORE the winning plan is pinned/digested:
 *
 *   reconcilePlanDataflow(tasks)
 *     - injects the missing dependency edge when exactly one earlier
 *       producer exists (durable repair evidence pinned on the task);
 *     - FAIL CLOSED on unbound input, ambiguous producer, backward
 *       producer, or a repair that would create an invalid DAG;
 *     - persists `metadata.pair_dataflow` (produces/consumes) on every
 *       canonical task so the pinned plan carries the artifact contract.
 *
 *   assertPlanDataflow(tasks)
 *     - pure validation (never mutates): replayed at preview/pin/confirm/
 *       replan boundaries so a persisted unsound DAG fails closed instead
 *       of being consumed into a mission.
 *
 *   provenMissingConsumedArtifact(...) / missingConsumedArtifact(...)
 *     - evidence-based prerequisite seam: a task whose canonical
 *       `consumes` artifact is absent from the workspace BEFORE dispatch
 *       is a deterministic prerequisite failure (DEPENDENCY_FAILURE),
 *       never inferred from executor summary text and never inferred
 *       from post-execution absence.
 *
 *   detectTelegramDeliveryIntent(goal)
 *     - bounded deterministic contract on the effective operator
 *       request: explicit Telegram-delivery phrasing pins the canonical
 *       manifest (`pair_telegram_delivery`) the delivery task may send.
 *
 * R2 reserved fields — `pair_dataflow`, `pair_dataflow_repairs`,
 * `pair_telegram_delivery`, `telegram_delivery`, `telegram_delivery_requested`,
 * `telegram_intent` are PAIR-reserved: they are stripped from raw planner
 * output before reconciliation so an untrusted plan cannot mint artifact,
 * repair, or delivery authority. PAIR recomputes and stamps them itself.
 *
 * Artifact evidence is derived only from authoritative/explicit task
 * material — structured worker_spec ops (read_text_file/write_text_file/
 * append_text_file/delete_file paths), explicit workspace-relative file
 * paths in the canonical instruction attributed by a bounded nearest-verb
 * grammar, declared `metadata.pair_dataflow` (PAIR-stamped only), and the
 * explicit delivery contract (a TELEGRAM_DELIVERY task consumes only the
 * manifest artifacts + required upstream result text — it is a DAG leaf
 * and never gains forward dependencies). Remote-capability tasks
 * produce/consume NO workspace artifacts: their files stay remote; a
 * governed /api/outbox upload is separately modeled as a staged copy
 * edge for delivery manifest resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { IntegrityError } from "./errors.js";
import {
  DELIVERY_TEXT_ARTIFACT,
  isTextDeliverableName,
  languagePhrase,
  PAIR_OUTPUT_LANGUAGE_KEY,
} from "./output-language.js";
import type { OutputLanguage } from "./output-language.js";
import { canonicalJson } from "./canonical.js";

export const DELIVERY_CAPABILITY = "TELEGRAM_DELIVERY";

/** Capabilities whose execution happens off-workspace: their file I/O is
 *  remote-only, so they never produce or consume local artifacts. */
export const REMOTE_CAPABILITY_SET = new Set([
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
]);

export interface TaskDataflow {
  /** Normalized workspace-relative paths this task creates/writes. */
  produces: string[];
  /** Normalized workspace-relative paths this task needs to already exist. */
  consumes: string[];
}

export interface DataflowRepair {
  consumer_key: string;
  producer_key: string;
  artifact: string;
  reason: "ARTIFACT_DATAFLOW";
  original_depends_on: string[];
  resulting_depends_on: string[];
}

export const MAX_ARTIFACTS_PER_TASK = 32;
const MAX_PATH_LEN = 240;
const MAX_MANIFEST_ARTIFACTS = 16;

/** PAIR-reserved task metadata keys — raw planner output must never mint
 *  artifact, repair, or Telegram-delivery authority. Stripped at the top
 *  of reconcilePlanDataflow before any extraction runs; PAIR recomputes
 *  and re-stamps them on the canonical list itself. */
/** First-pass declared depends_on, stamped once and preserved across
 *  replays so the repair ledger recomputes byte-identically. Not a
 *  reserved key — a forged value only mutates evidence, never edges. */
export const PAIR_DATAFLOW_ORIGINAL_DEPS = "pair_dataflow_original_deps";

/** R1.3/R2.2 — PAIR-owned plan-contract version marker. Stamped on every
 *  canonical TELEGRAM_DELIVERY task at the same reconcile seam as
 *  `pair_output_language`. The marker is MANDATORY on every delivery
 *  task at every validation boundary: marker absence is NOT proof of a
 *  legacy plan (a fresh plan that bypassed reconcile looks identical),
 *  so pre-contract shapes are rejected and must be re-planned under the
 *  current contract era (forced-replan semantics — no `absent =>
 *  legacy` inference, no unlimited tolerance). PAIR-reserved: the
 *  planner cannot mint it. */
export const PAIR_PLAN_CONTRACT_KEY = "pair_plan_contract";
export const PAIR_PLAN_CONTRACT_VERSION = 2;

/** HOTFIX-A — PAIR-owned cross-mission input binding ledger. Stamped by
 *  `bindPlanExternalInputs` when a consumed artifact has no in-plan
 *  producer but resolves to exactly one canonical artifact the mission's
 *  authorized lineage may consume. PAIR-reserved: the planner can never
 *  mint source authority; it is stripped + recomputed at reconcile. */
export const PAIR_DATAFLOW_SOURCES = "pair_dataflow_sources";
export const EXTERNAL_INPUT_CONTRACT = "pair-external-artifact-input.v1";

/** R3-F5 — deterministic consume name for an eligible external input
 *  whose canonical `logical_name` cannot be expressed by the
 *  plan-dataflow path grammar (spaces/unicode in the basename) or whose
 *  name collides with an in-plan produced artifact (R3-F4: a same-named
 *  in-plan produce must never silently shadow the external source — a
 *  task cannot consume its own not-yet-produced output, so the
 *  identity-pinned alias is the unambiguous declaration). The alias is
 *  a pure function of the immutable artifact_id, always normalized by
 *  `normalizeArtifactPath`, and can never collide with any in-plan
 *  produce name. The stamped ledger still carries the real
 *  `logical_name`; dispatch materializes under the real name inside the
 *  namespaced `.pair/dependency-artifacts/` consumer path. */
export function externalConsumeAlias(artifactId: string): string {
  return `.pair/external/${artifactId}.artifact`;
}
const EXTERNAL_CONSUME_ALIAS_RE =
  /^\.pair\/external\/([A-Za-z0-9_-]+)\.artifact$/;

/** R3 — a PAIR-owned declaration that task `task_key` consumes the
 *  eligible external input `artifact_id`. Passed only through
 *  `ReconcileOptions.declared_external_inputs` — never through task
 *  metadata, so planner-controlled fields can never mint it. */
export interface DeclaredExternalInput {
  task_key: string;
  artifact_id: string;
}

/** One pinned external input: the consume name bound to the immutable
 *  canonical identity of an ACCEPTED artifact produced by a mission in
 *  the consumer mission's authorized lineage (objective/business scope,
 *  resolved by trusted PAIR code — never by planner-supplied fields). */
export interface ExternalInputArtifactSource {
  contract: typeof EXTERNAL_INPUT_CONTRACT;
  artifact_id: string;
  logical_name: string;
  sha256: string;
  byte_size: number;
  source_mission_id: string;
  source_task_id: string;
  source_governed_task_id: string;
  source_execution_id: string;
  source_executor_id: string;
}

export const RESERVED_TASK_METADATA_KEYS = [
  "pair_dataflow",
  "pair_dataflow_repairs",
  PAIR_DATAFLOW_SOURCES,
  "pair_telegram_delivery",
  "telegram_delivery",
  "telegram_delivery_requested",
  "telegram_intent",
  PAIR_OUTPUT_LANGUAGE_KEY,
  PAIR_PLAN_CONTRACT_KEY,
] as const;

function stripReservedTaskMetadata(
  tasks: Array<Record<string, unknown>>,
): void {
  for (const t of tasks) {
    const md = t?.metadata;
    if (!md || typeof md !== "object" || Array.isArray(md)) continue;
    for (const k of RESERVED_TASK_METADATA_KEYS) {
      delete (md as Record<string, unknown>)[k];
    }
  }
}

/* ---------------- Telegram delivery intent (operator-request authority) */

export interface TelegramDeliveryIntent {
  /** True only when the operator's own goal text explicitly asks to send
   *  something to Telegram — file presence, mission completion, or an
   *  outbox artifact never imply it. */
  requested: boolean;
  /** Exact file names the goal mentions (normalized, bounded). */
  artifacts: string[];
  /** FILES = send the manifested artifacts; TEXT = send the composed
   *  result text only (no implicit attachment of workspace files). */
  mode: "FILES" | "TEXT";
}

// The operator must BOTH name Telegram AND use a delivery verb — a bare
// "telegram" mention (e.g. asking about the app) is not delivery intent.
// R3: the verb and the mention must share ONE delivery clause (within
// CLAUSE_SPAN chars), and only artifacts INSIDE that clause's bounded
// list grammar authorize files — a file mentioned elsewhere in the goal
// is never manifested. A negated clause ("do not send", "đừng gửi",
// "không cần gửi") authorizes nothing: the safe direction is NO SEND.
// Word boundaries are Unicode-aware lookarounds (NOT \b): JS \b treats
// only ASCII letters as word chars, so "đừng gửi"/'đẩy lên' never
// matched the ASCII boundary and negated Vietnamese clauses slipped
// through as send authority. (?<!L/N/M/_)(?!L/N/M/_) is the real
// letter boundary for Vietnamese text.
const TELEGRAM_MENTION_RE = /(?<![\p{L}\p{N}\p{M}_])(?:telegram|tele)(?![\p{L}\p{N}\p{M}_])/giu;
const DELIVERY_VERB_RE =
  // `gui` is the high-confidence unaccented alias of `gửi` (R8-R1 audit
  // closure); only bare-alias safe verbs are admitted — accents are never
  // stripped globally (báo→bao would collide with "bao cao" = report).
  /(?<![\p{L}\p{N}\p{M}_])(?:send|deliver|forward|share|post|upload|gửi|gui|đẩy|đưa|chuyển|báo|bắn|đăng|đính)(?![\p{L}\p{N}\p{M}_])/giu;
const NEGATION_RE =
  /(?<![\p{L}\p{N}\p{M}_])(?:do\s+not|don't|dont|does\s+not|doesn't|doesnt|never|not|no|đừng|dung|không|khong|không\s+cần|khong\s+can|chớ|đừng\s+có|không\s+phải|không\s+bao\s+giờ)(?![\p{L}\p{N}\p{M}_])/iu;
const CLAUSE_SPAN = 160;
const CLAUSE_LIST_SPAN = 200;
const CLAUSE_NEGATION_LOOKBACK = 48;
// `post` is BOTH an English delivery verb and a Vietnamese marketing
// noun ("bài post Telegram" = a post FOR Telegram — content to WRITE,
// never a send instruction). It is a delivery verb only in verb
// position: an object or a preposition must sit between it and the
// channel ("post report.txt to telegram", "post it on telegram").
// A directly adjacent channel mention ("post telegram", "telegram
// post") or a governing article/classifier/write-verb ("3 bài post",
// "a post", "viết post") makes it a noun — content scope, never send
// authority. The noun-left list is deliberately short: determiners,
// classifiers, numerals, content-type nouns and write-governing verbs
// only — anything else leaves `post` a verb (fail-safe toward the
// established delivery grammar, and an adjacent-mention noun phrase
// is caught by POST_MENTION_GAP regardless).
const POST_NOUN_LEFT_RE =
  /(?<![\p{L}\p{N}\p{M}_])(?:bài\s+viết|nội\s+dung|thông\s+báo|bài|bản|cái|đoạn|loại|kiểu|dạng|số|content|article|story|status|update|caption|blog|thread|threads|tweet|announcement|video|clip|reel|reels|vlog|a|an|the|this|that|these|those|một|vài|các|những|mỗi|mọi|some|any|all|each|every|write|viết|soạn|draft|compose|create|tạo|làm|prepare|produce|generate|author|craft|pen|schedule|scheduled|plan|\d+)(?![\p{L}\p{N}\p{M}_])\s*$/iu;
// `đăng` is BOTH a Vietnamese delivery verb ("đăng bài lên kênh" =
// post an article to the channel) and the head of content-production
// noun compounds whose head sits BEFORE it ("bài đăng" = the post,
// "lịch đăng" = the posting schedule, "gói bài đăng" = the post
// bundle). Only a bounded left-neighbor class — Vietnamese classifiers/
// content nouns, determiners, numerals and write/schedule-governing
// verbs — makes it a noun; anything else keeps the verb reading
// (fail-safe toward the delivery grammar, exactly like `post`).
// Object-after-verb order is untouched: "đăng bài", "đăng lên",
// "đăng các file" still authorize.
const DANG_NOUN_LEFT_RE =
  /(?<![\p{L}\p{N}\p{M}_])(?:bài|lịch|gói|bản|tin|nội\s+dung|thông\s+báo|danh\s+sách|chuỗi|số|video|clip|story|stories|reel|reels|vlog|blog|thread|threads|tweet|caption|post|bài\s+viết|article|content|status|update|announcement|schedule|scheduled|plan|draft|một|vài|các|những|mỗi|mọi|nhiều|ít|a|an|the|this|that|these|those|some|any|all|each|every|write|viết|soạn|compose|create|tạo|làm|prepare|produce|sản\s+xuất|generate|author|craft|pen|\d+)(?![\p{L}\p{N}\p{M}_])\s*$/iu;
// `đăng ký` is the compound verb "subscribe/register" — never a send
// instruction ("đăng ký kênh Telegram" = subscribe to the channel).
// `đăng tải`/`đăng lên` ARE real publish/send verbs and must not be
// suppressed — only `ký` is a noun-compound forgery to skip.
const DANG_KY_RIGHT_RE = /^\s*ký(?![\p{L}\p{N}\p{M}_])/iu;
// Only separators may sit between a noun `post` and the channel
// mention — any real word (an object, a preposition) keeps the verb
// reading alive.
const POST_MENTION_GAP = /^[\s,;:.!?'"()\-–—/]*$/u;
// Filler consumed between consecutive artifact names inside a delivery
// clause: list separators, prepositions, articles, and the Telegram
// mention itself (covers "gửi telegram file a.txt" and "send a.txt to
// telegram" orders alike).
const CLAUSE_FILLER =
  /^(?:[\s,.;:!?]+|(?:and|or|và|only|file|files|the|a|an|to|into|onto|in|for|with|named|as|keep|keeping|copy|qua|lên|trên|cho|của|các|cái|all|both|it|them|this|that|these|those|via|over|by|bằng|qua|qua\s+chat|telegram|tele)(?![\p{L}\p{N}\p{M}_]))\s*/iu;
const CLAUSE_PATH =
  /^(?:outbox\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)?|(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10})(?=$|[^\w/.-])/;

/** Parse the bounded artifact list that follows a delivery verb: only
 *  path tokens chained by filler/separators count. Path tokens are
 *  checked BEFORE filler so filler articles ("a", "an") can never eat
 *  the stem of a filename ("a.txt"). Stops at the first non-filler,
 *  non-path token — files mentioned outside the clause never enter
 *  the manifest. */
function clauseArtifacts(text: string, verbEnd: number): string[] {
  const out: string[] = [];
  let pos = verbEnd;
  const limit = Math.min(text.length, verbEnd + CLAUSE_LIST_SPAN);
  while (pos < limit && out.length < MAX_MANIFEST_ARTIFACTS) {
    // Filler first when at a separator/article boundary…
    let consumed = true;
    while (consumed && pos < limit) {
      consumed = false;
      CLAUSE_FILLER.lastIndex = 0;
      const f = CLAUSE_FILLER.exec(text.slice(pos, limit));
      if (f && f[0].length > 0) {
        // …but never let a filler article swallow a real path token.
        const p = CLAUSE_PATH.exec(text.slice(pos, limit));
        if (p) break;
        pos += f[0].length;
        consumed = true;
      }
    }
    const p = CLAUSE_PATH.exec(text.slice(pos, limit));
    if (!p) break;
    const name = normalizeArtifactPath(p[0]);
    if (!name) break;
    if (!out.includes(name)) out.push(name);
    pos += p[0].length;
  }
  return out;
}

/** A clause is negated when a negation marker governs the verb — bounded
 *  lookback, cut at the previous sentence/clause boundary so a negation
 *  in an earlier clause cannot bleed in. */
function clauseNegated(text: string, verbStart: number): boolean {
  let seg = text.slice(
    Math.max(0, verbStart - CLAUSE_NEGATION_LOOKBACK),
    verbStart,
  );
  const cut = seg.search(/[,;.!?\n][^,;.!?\n]*$/);
  if (cut >= 0) seg = seg.slice(cut + 1);
  return NEGATION_RE.test(seg);
}

/**
 * Bounded deterministic intent contract over the effective operator
 * request (the mission goal). Deliberately conservative: unknown
 * phrasings resolve to NOT requested — the safe direction is no send.
 * A delivery clause = a delivery verb with a Telegram mention within
 * CLAUSE_SPAN chars, not negated. Artifacts = only the bounded list
 * inside authorized clauses; ambiguous scope → TEXT mode.
 */
export function detectTelegramDeliveryIntent(
  goal: unknown,
): TelegramDeliveryIntent {
  // NFC-normalize so decomposed Vietnamese text ("g\u01B0\u0309i")
  // matches the same clause grammar as precomposed input.
  const text = String(goal ?? "").normalize("NFC").slice(0, 4096);
  const mentions: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  TELEGRAM_MENTION_RE.lastIndex = 0;
  while ((m = TELEGRAM_MENTION_RE.exec(text)) !== null) {
    mentions.push({ start: m.index, end: m.index + m[0].length });
  }
  if (!mentions.length) return { requested: false, artifacts: [], mode: "TEXT" };
  const artifacts: string[] = [];
  let requested = false;
  DELIVERY_VERB_RE.lastIndex = 0;
  while ((m = DELIVERY_VERB_RE.exec(text)) !== null) {
    // The `i` flag makes the unaccented `gui` alias also match `GUI` — but
    // all-caps is the technical acronym (Graphical User Interface), never
    // the Vietnamese verb. Fail closed toward NO SEND: reject only when
    // the matched token is exactly all-caps GUI; `gui`/`Gui` stay valid.
    if (m[0] === "GUI") continue;
    // `post` — see POST_NOUN_LEFT_RE: in Vietnamese marketing text it is
    // overwhelmingly a NOUN ("3 bài post Telegram", "viết bài post").
    // Reject it as a delivery verb when a determiner/classifier/
    // write-verb governs it or when the channel mention is directly
    // adjacent in either direction (noun compounds). "post report.txt
    // to telegram" / "post it on telegram" keep an object or a
    // preposition between verb and channel — those still authorize.
    const v = m.index;
    if (/^post$/iu.test(m[0])) {
      const vEnd = v + m[0].length;
      if (POST_NOUN_LEFT_RE.test(text.slice(Math.max(0, v - 48), v))) {
        continue;
      }
      const adjacent = mentions.some((mn) =>
        mn.start > vEnd
          ? POST_MENTION_GAP.test(text.slice(vEnd, mn.start))
          : mn.end < v
            ? POST_MENTION_GAP.test(text.slice(mn.end, v))
            : false,
      );
      if (adjacent) continue;
    }
    // `đăng` — Vietnamese noun compounds put the head BEFORE the word
    // ("bài đăng", "lịch đăng", "gói bài đăng"); a bounded left neighbor
    // makes it content-production scope, never send authority. The
    // compound verb `đăng ký` (subscribe) is likewise never a send.
    // Verb-object order ("đăng bài lên kênh") is untouched.
    if (/^đăng$/iu.test(m[0])) {
      if (DANG_NOUN_LEFT_RE.test(text.slice(Math.max(0, v - 48), v))) {
        continue;
      }
      if (DANG_KY_RIGHT_RE.test(text.slice(v + m[0].length))) {
        continue;
      }
    }
    const clause = mentions.some((p) => Math.abs(p.start - v) <= CLAUSE_SPAN);
    if (!clause || clauseNegated(text, v)) continue;
    requested = true;
    for (const a of clauseArtifacts(text, v + m[0].length)) {
      if (!artifacts.includes(a)) artifacts.push(a);
    }
    if (artifacts.length >= MAX_MANIFEST_ARTIFACTS) break;
  }
  return {
    requested,
    artifacts: artifacts.slice(0, MAX_MANIFEST_ARTIFACTS),
    mode: artifacts.length ? "FILES" : "TEXT",
  };
}

/** The PAIR-stamped manifest field name on a canonical delivery task. */
export const TELEGRAM_MANIFEST_FIELD = "pair_telegram_delivery";

// A path token: workspace-relative segments ending in a filename — either
// `name.ext` or an `outbox/` path. The token must not be preceded by a path
// character, so absolute paths like `/home/x/f.txt` never match (the `/`
// before `home` is in the negated class and swallows the whole token). A
// trailing `.` counts as a boundary only when it does NOT continue the
// filename — sentence-final `report.md.` is still `report.md`, while
// `file.txt.bak` never degrades to `file.txt`.
const PATH_TOKEN =
  /(?:^|[^\w/.-])(outbox\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)?|(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10})(?=$|[^\w/.-]|\.(?![\w-]))/g;

// Verbs attributing a read/consume role to the following path.
const CONSUME_VERB =
  /\b(?:read|reads|reading|load|loads|cat|consume|consumes|review|summarize|summarise|inspect|check|open|opens|use|uses|using|copy|copies|copying|move|moves|attach|includes?|including|contains|from|compare|compares|comparing|reference|references|refer|versus|vs)\b/gi;
// Transfer verbs consume their source but produce their destination —
// "copy input.csv to output.csv" consumes input.csv, produces
// output.csv. Detected by the exact governing word so a bare consume
// role never blinds the destination rule.
const TRANSFER_WORDS = new Set([
  "copy",
  "copies",
  "copying",
  "move",
  "moves",
  "moving",
  "summarize",
  "summarizes",
  "summarise",
  "tóm tắt",
]);
// Verbs attributing a write/produce role to the following path.
const PRODUCE_VERB =
  /\b(?:write|writes|writing|create|creates|creating|produce|produces|producing|generate|generates|save|saves|saving|output|outputs|emit|emits|place|places|put|puts|store|stores|persist|persists|upload|uploads|format|formats|formatting|compose|composes|composing)\b/gi;
// Vietnamese verb alternates carrying the same attribution roles as the
// English lists — planner-authored instructions are routinely Vietnamese
// and a verb the lists do not know leaves every path mention
// unattributed (produces=[] was the live P-GRAMMAR3 incident). Boundary
// form differs from `\b`: several lexemes begin/end on a diacritic vowel
// (`mở`, `giá`) where \b cannot fire, so these consume a leading
// non-letter boundary and use a trailing lookahead. Multi-word lexemes
// are listed before their prefixes so the longest match wins.
const CONSUME_VERB_VI =
  /(?:^|[^\p{L}\p{N}])(đọc|mở|xem xét|xem|so sánh|đối chiếu|phân tích|đánh giá|kiểm tra|kiểm|tham khảo|rà soát|sử dụng|dùng|lấy|tóm tắt)(?=[^\p{L}\p{N}]|$)/giu;
/** A VI action token trailing a naming noun is the noun-phrase suffix,
 *  not a governing verb — "viết báo cáo phân tích vào x.txt" must
 *  attribute x.txt to `viết`, never let `phân tích` steal the role. */
const VI_NOUN_SUFFIX =
  /(?:báo cáo|bản|file|tài liệu|kết quả|nội dung|bảng|danh sách)\s*$/iu;
const PRODUCE_VERB_VI =
  /(?:^|[^\p{L}\p{N}])(tạo|viết|ghi|soạn|lưu|xuất|sinh|xây dựng|kết xuất)(?=[^\p{L}\p{N}]|$)/giu;
// Destination marker immediately before the path: "to X", "into
// outbox/X", "in X".
const DESTINATION_ADJACENT = /\b(?:to|into|onto|inside|in|vào|trong)\s*$/i;
// Modifier-separated destination: the marker followed by a bounded run
// of words — "format the findings into a professional report.md". A
// gap-word destination is NOT independently a producer: it only mints a
// produced artifact when a produce/transform verb governs the phrase
// ("format"), so purpose phrases like "to compare with baseline.csv"
// stay consumes under their governing read/use semantics.
const DESTINATION_GAP = /\b(?:to|into|onto|inside|vào|trong)(?:\s+[\w-]+){1,5}\s*$/i;

/* --- DEBT A: negative space for dotted tokens -------------------------
 * PATH_TOKEN's catch-all `name.[A-Za-z0-9]{1,10}` shape also matches
 * dotted identifiers that are never workspace artifacts — hostnames
 * ("website github.com" minted consumes:["github.com"] and killed the
 * live hermes-agent plan with UNBOUND_INPUT), version strings ("v1.2",
 * "gpt-6.1"), and web-doc references ("node.js docs"). Rejection lives
 * only on this instruction free-text seam: normalizeArtifactPath() also
 * validates structured/authoritative declarations where "notes.io" is a
 * legitimate name, so the host check must NOT be global. */
const TLD_LIKE_EXT = new Set([
  "com", "org", "net", "io", "ai", "dev", "app", "xyz", "info",
  "co", "gov", "edu", "me", "us", "site", "online", "cloud",
]);
// Web-flavored markers that make a single-segment dotted token an
// external identifier rather than a workspace file — "website node.js",
// "node.js docs". Consulted only after the numeric/TLD shape checks, so
// ".js" stays mintable in file context ("Đọc file node.js").
const EXTERNAL_MARKER_BEFORE =
  /(?:website|web\s?site|docs?|documentation|blog|forum|homepage)\s*$/iu;
const EXTERNAL_MARKER_AFTER =
  /^\s*(?:docs?|documentation|website|web\s?site|blog|forum|homepage)\b/i;

function isNonArtifactDottedToken(
  token: string,
  before: string,
  after: string,
): boolean {
  if (token.includes("/")) return false; // directory-carrying = real path
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = token.slice(dot + 1).toLowerCase();
  if (/^\d+$/.test(ext)) return true; // v1.2 / gpt-6.1 — version, not file
  if (TLD_LIKE_EXT.has(ext)) return true; // github.com — host, not file
  if (EXTERNAL_MARKER_BEFORE.test(before)) return true;
  if (EXTERNAL_MARKER_AFTER.test(after)) return true;
  return false;
}

/* Negated VI write — "không|chưa|đừng [có|được|được phép] <produce-verb>
 * [≤5 modifier words] trong|vào X", optionally prefixed by `đã`. A
 * prohibition carries neither read evidence nor write authority: the
 * mention mints NOTHING (a minted produce would fabricate a producer
 * and mask a missing real one downstream). The guard is anchored at
 * the very end of the tail window so a negation in an earlier clause
 * never poisons a later affirmative write — "Không truy cập Internet.
 * Ghi kết quả vào report.md" still produces report.md. Checked before
 * the passive and destination rules so the produce verb can't re-mint
 * through those paths. */
const NEGATED_WRITE_VI =
  /(?:đã\s+)?(?:không|chưa|đừng)\s+(?:(?:có|được(?:\s+phép)?)\s+)?(?:ghi|viết|soạn|lưu|xuất|tạo|sinh|xây\s+dựng|kết\s+xuất)(?:\s+[\p{L}\p{N}-]+){0,5}\s+(?:trong|vào)\s*$/iu;

/* Passive VI reference — bounded per-phrase semantics, never an
 * unconditional demote:
 *   "(đã) được <produce-verb> trong X" — containment/reference: can
 *   never mint produce (a passive mention grants no write authority),
 *   and mints consume ONLY when the text before the passive phrase
 *   independently shows a read/reference verb ("Đọc các phát hiện đã
 *   được ghi trong X" — `đọc` proves the read). Without independent
 *   evidence the mention is ignored, never guessed.
 *   "(đã) được <produce-verb> vào X" — passive destination: `vào`
 *   keeps output semantics ("Kết quả được ghi vào report.md"), the
 *   mention stays a produce and never demotes to consume.
 *   A negated passive ("không|đừng|chưa được ghi …") is a prohibition:
 *   neither consume nor produce — prohibition is not read evidence.
 * Group 1 = optional negation, group 2 = the preposition. */
const PASSIVE_VI =
  /(?:(không|đừng|chưa)\s+)?(?:đã\s+)?được\s+(?:ghi|viết|soạn|lưu|xuất|tạo|sinh|xây\s+dựng|kết\s+xuất)\s+(trong|vào)\s*$/iu;

/** Nearest governing verb before a path mention: the LAST consume/produce
 *  verb inside the bounded lookback window wins — "read input.txt then
 *  generate report.txt" attributes `report.txt` to `generate` (produce),
 *  never to the earlier `read`. Returns null when unattributed. The
 *  matched word is reported so transfer verbs (copy/move) can grant
 *  produce authority to their destination while consuming their source. */
function nearestVerbMatch(
  before: string,
): { role: "consume" | "produce"; index: number; word: string } | null {
  let best: {
    role: "consume" | "produce";
    index: number;
    word: string;
  } | null = null;
  let m: RegExpExecArray | null;
  CONSUME_VERB.lastIndex = 0;
  while ((m = CONSUME_VERB.exec(before)) !== null) {
    if (!best || m.index >= best.index) {
      best = { role: "consume", index: m.index, word: m[0] };
    }
  }
  PRODUCE_VERB.lastIndex = 0;
  while ((m = PRODUCE_VERB.exec(before)) !== null) {
    if (!best || m.index >= best.index) {
      best = { role: "produce", index: m.index, word: m[0] };
    }
  }
  // Same nearest-verb rule for the Vietnamese alternates — a VI match
  // reports its capture so index/word stay honest, and a token parked
  // on a naming noun (báo cáo phân tích / bản tóm tắt) is skipped.
  CONSUME_VERB_VI.lastIndex = 0;
  while ((m = CONSUME_VERB_VI.exec(before)) !== null) {
    const index = m.index + m[0].length - m[1].length;
    if (VI_NOUN_SUFFIX.test(before.slice(0, index))) continue;
    if (!best || index >= best.index) {
      best = { role: "consume", index, word: m[1] };
    }
  }
  PRODUCE_VERB_VI.lastIndex = 0;
  while ((m = PRODUCE_VERB_VI.exec(before)) !== null) {
    const index = m.index + m[0].length - m[1].length;
    if (VI_NOUN_SUFFIX.test(before.slice(0, index))) continue;
    if (!best || index >= best.index) {
      best = { role: "produce", index, word: m[1] };
    }
  }
  return best;
}

function nearestVerbRole(before: string): "consume" | "produce" | null {
  return nearestVerbMatch(before)?.role ?? null;
}

/**
 * Normalize a workspace-relative artifact path. Returns null for anything
 * unsafe or ambiguous — absolute paths, `..`, backslashes, bare directory
 * refs, over-length, or non-filename segments are never artifacts.
 */
export function normalizeArtifactPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p || p.length > MAX_PATH_LEN) return null;
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p)) {
    return null; // absolute
  }
  if (p.includes("\\") || p.includes("\0")) return null;
  if (p.endsWith("/")) return null; // directory ref, not an artifact
  p = p.replace(/^\.(\/)+/, "").replace(/\/{2,}/g, "/");
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  const base = segs[segs.length - 1];
  if (!/^[\w-]+(\.[\w-]+)*$/.test(base) || !base.includes(".")) return null;
  return p;
}

/** Paths read/written by structured worker_spec ops — authoritative. */
function contractArtifacts(task: Record<string, unknown>): TaskDataflow {
  const produces = new Set<string>();
  const consumes = new Set<string>();
  const spec = (
    (task.metadata as Record<string, unknown> | undefined)
      ?.expected_output_contract as Record<string, unknown> | undefined
  )?.worker_spec as Record<string, unknown> | undefined;
  const ops = Array.isArray(spec?.ops) ? (spec.ops as Array<Record<string, unknown>>) : [];
  for (const op of ops) {
    const p = normalizeArtifactPath(op?.path);
    if (!p) continue;
    if (op.op === "write_text_file" || op.op === "append_text_file") {
      produces.add(p);
    } else if (op.op === "read_text_file" || op.op === "delete_file") {
      consumes.add(p);
    }
  }
  return { produces: [...produces], consumes: [...consumes] };
}

/**
 * Bounded instruction-text grammar: a path mention counts only when the
 * NEAREST governing verb attributes a role to it (deterministic local
 * attribution, bounded 120-char lookback). A destination marker before
 * the path (`to`, `into`, `onto`, `in`, optionally followed by a bounded
 * modifier run) mints a produce only under a produce/transform or
 * transfer governing verb — "write report to report.md" and "copy X to
 * outbox/Y" produce their destinations, while "compare results to
 * baseline.csv" stays a consume under its compare verb. Mentions with
 * no attributed verb are ignored (bounded grammar never guesses).
 */
function instructionArtifacts(task: Record<string, unknown>): TaskDataflow {
  const produces = new Set<string>();
  const consumes = new Set<string>();
  const instruction = String(
    task.task_instruction ?? task.description ?? "",
  ).slice(0, 4096);
  let m: RegExpExecArray | null;
  PATH_TOKEN.lastIndex = 0;
  while ((m = PATH_TOKEN.exec(instruction)) !== null) {
    const p = normalizeArtifactPath(m[1]);
    if (!p) continue;
    const before = instruction.slice(Math.max(0, m.index - 120), m.index);
    const tail = before.slice(-48);
    const after = instruction.slice(
      m.index + m[0].length,
      m.index + m[0].length + 48,
    );
    if (isNonArtifactDottedToken(p, tail, after)) continue;
    const near = nearestVerbMatch(before);
    const role = near?.role ?? null;
    // Negated write — prohibition mints neither consume nor produce.
    if (NEGATED_WRITE_VI.test(tail)) continue;
    // Passive VI reference — bounded: negation mints nothing; `vào`
    // keeps destination produce; `trong` consumes only with independent
    // read evidence left of the passive phrase, else the mention is
    // ignored rather than guessed.
    const passive = PASSIVE_VI.exec(tail);
    if (passive !== null) {
      if (passive[1] !== undefined) continue; // prohibition
      if (passive[2].toLowerCase() === "vào") {
        produces.add(p);
        continue;
      }
      const rest = before.slice(0, before.length - passive[0].length);
      if (nearestVerbMatch(rest)?.role === "consume") {
        consumes.add(p);
      }
      continue;
    }
    // Destination markers (adjacent or modifier-separated) mint a produce
    // ONLY under a governing produce/transform verb or a transfer verb —
    // "write report to report.md" produces report.md; "copy input.csv to
    // output.csv" produces output.csv; but "compare results to
    // baseline.csv" keeps baseline.csv a consume under its governing
    // compare verb — a `to FILE` phrase never independently mints an
    // output. Otherwise the path falls back to ordinary verb attribution.
    const transfer = near !== null && TRANSFER_WORDS.has(near.word.toLowerCase());
    if (
      (DESTINATION_ADJACENT.test(tail) || DESTINATION_GAP.test(tail)) &&
      (role === "produce" || transfer)
    ) {
      produces.add(p);
      continue;
    }
    if (role === "consume") {
      consumes.add(p);
      continue;
    }
    if (role === "produce" || p.startsWith("outbox/")) {
      // Nearest write verb, or the known outbox contract.
      produces.add(p);
      continue;
    }
    // no attributed role → ignored on purpose
  }
  return { produces: [...produces], consumes: [...consumes] };
}

/** Explicit operator/planner declaration — normalized and validated, never
 *  trusted verbatim (unsafe entries fail closed at reconcile). */
function declaredArtifacts(task: Record<string, unknown>): TaskDataflow {
  const df = (
    (task.metadata as Record<string, unknown> | undefined)?.pair_dataflow as
      | Record<string, unknown>
      | undefined
  ) ?? {};
  const list = (v: unknown): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_SCHEMA",
        `${String(task.task_key ?? "?")}:pair_dataflow`,
      );
    }
    return v.map((x) => String(x));
  };
  return { produces: list(df.produces), consumes: list(df.consumes) };
}

const isRemoteTask = (task: Record<string, unknown>): boolean =>
  ((task.required_capabilities as string[]) ?? []).some((c) =>
    REMOTE_CAPABILITY_SET.has(String(c)),
  );

/** HOTFIX 1 — exported so the canonicalize seam (serve-planner) can
 *  prove raw-vs-canonical delivery omission with the SAME predicate the
 *  reconcile uses. One definition, one authority. */
export const isDeliveryTask = (task: Record<string, unknown>): boolean =>
  ((task.required_capabilities as string[]) ?? []).includes(DELIVERY_CAPABILITY);

/** HOTFIX 1 R1/R2 — TRUE raw delivery-emission evidence, captured at the
 *  FIRST point where parsed provider JSON still holds the actual raw
 *  task array (before ANY sanitize/drop/truncate/remap). Unlike
 *  `isDeliveryTask`, this detector is safe on arbitrary malformed
 *  provider output: `required_capabilities` may be an array, a scalar
 *  string, an object, a number, null — every shape is walked with
 *  bounded depth + a shared node budget and EXACT-token semantics only
 *  (a substring like "NOT_TELEGRAM_DELIVERY" never matches; an object
 *  KEY carrying the exact token still counts — R2 defect A). A
 *  malformed emission attempt still counts as an emission: the
 *  canonicalizer must then prove malformed-drop (fail closed), never
 *  classify it as a true omission.
 *
 *  R2 — TRI-STATE, never boolean: the result is ABSENT (every task's
 *  capability field fully inspected, no token), PRESENT (fully
 *  inspected, ≥1 emitting task), or INDETERMINATE (depth/node budget
 *  exhausted before all content was inspected — a buried token was
 *  never disproven). Budget exhaustion must NEVER masquerade as a
 *  proven R=0; the caller must fail closed on INDETERMINATE.
 *  Never throws; descriptive planner provenance, zero authority. */
export type RawDeliveryEmissionState = "ABSENT" | "PRESENT" | "INDETERMINATE";
export type RawDeliveryEmissionInspection = {
  state: RawDeliveryEmissionState;
  /** Tasks carrying an exact TELEGRAM_DELIVERY token in
   *  `required_capabilities`. Exact when state is ABSENT/PRESENT; a
   *  LOWER BOUND when INDETERMINATE — never a proven count. */
  count: number;
};
const RAW_DELIVERY_DEPTH_LIMIT = 8;
const RAW_DELIVERY_NODE_BUDGET = 4000;

const inspectCapsValue = (
  v: unknown,
  depth: number,
  budget: { left: number },
): RawDeliveryEmissionState => {
  if (v === null || v === undefined) return "ABSENT";
  if (budget.left <= 0) return "INDETERMINATE";
  budget.left -= 1;
  if (typeof v === "string") {
    return v === DELIVERY_CAPABILITY ? "PRESENT" : "ABSENT";
  }
  if (typeof v !== "object") return "ABSENT"; // number/boolean — safely not a token
  const entries = Array.isArray(v)
    ? v.map((x) => [null, x] as const)
    : Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "ABSENT";
  // Any container content beyond the depth limit was never inspected —
  // a token could be buried there: INDETERMINATE, never proven ABSENT.
  if (depth >= RAW_DELIVERY_DEPTH_LIMIT) return "INDETERMINATE";
  let sawIndeterminate = false;
  for (const [k, x] of entries) {
    // R2-A — a malformed object may carry the exact capability token as
    // a KEY ({TELEGRAM_DELIVERY: true}): still a delivery emission.
    if (typeof k === "string" && k === DELIVERY_CAPABILITY) return "PRESENT";
    const r = inspectCapsValue(x, depth + 1, budget);
    if (r === "PRESENT") return "PRESENT";
    if (r === "INDETERMINATE") sawIndeterminate = true;
  }
  return sawIndeterminate ? "INDETERMINATE" : "ABSENT";
};

export const inspectRawDeliveryEmissions = (
  rawTasks: unknown,
): RawDeliveryEmissionInspection => {
  if (!Array.isArray(rawTasks)) return { state: "ABSENT", count: 0 };
  const budget = { left: RAW_DELIVERY_NODE_BUDGET };
  let count = 0;
  let indeterminate = false;
  for (const t of rawTasks) {
    const caps =
      t !== null && typeof t === "object"
        ? (t as Record<string, unknown>)["required_capabilities"]
        : undefined;
    const r = inspectCapsValue(caps, 0, budget);
    if (r === "PRESENT") count += 1;
    else if (r === "INDETERMINATE") indeterminate = true;
  }
  return {
    state: indeterminate ? "INDETERMINATE" : count > 0 ? "PRESENT" : "ABSENT",
    count,
  };
};

/** HOTFIX 1 — PAIR-owned provenance stamp on a delivery task that PAIR
 *  itself injected (true planner omission), e.g.
 *  `{reason:"DELIVERY_TASK_INJECTED", task_key:"T4", mode:"TEXT",
 *    authority:"OPERATOR_TELEGRAM_INTENT"}`. Digest-covered, bounded,
 *  replay byte-stable (preserved verbatim like pair_dataflow_original_
 *  deps — deliberately NOT in RESERVED_TASK_METADATA_KEYS). A planner
 *  cannot forge it: the canonicalize seam strips it from every
 *  planner-emitted task under fresh provenance before re-stamping it on
 *  the task it actually injected. */
export const PAIR_DELIVERY_INJECTION_KEY = "pair_delivery_injection";
export interface DeliveryInjectionRecord {
  reason: "DELIVERY_TASK_INJECTED";
  task_key: string;
  mode: "FILES" | "TEXT";
  authority: "OPERATOR_TELEGRAM_INTENT";
}

/** A pure bookkeeping task (goal record) is not content the operator
 *  asked to receive — TEXT-mode delivery never depends on it. */
const BOOKKEEPING_CAP = "AUTOMATON_TASK_EXECUTION";
const isContentBearing = (task: Record<string, unknown>): boolean =>
  ((task.required_capabilities as string[]) ?? []).some(
    (c) => String(c) !== BOOKKEEPING_CAP,
  );

export interface TelegramDeliveryManifest {
  mode: "FILES" | "TEXT";
  artifacts: string[];
}

/** The PAIR-stamped manifest on a canonical delivery task — the ONLY
 *  send authority for artifact transmission. Absent on a pinned
 *  TELEGRAM_DELIVERY task → the task carries no governed delivery
 *  authority and must fail closed at the canonical seams. */
export function deliveryManifest(
  task: Record<string, unknown>,
): TelegramDeliveryManifest | null {
  const raw = (
    (task.metadata as Record<string, unknown> | undefined)?.[
      TELEGRAM_MANIFEST_FIELD
    ] as Record<string, unknown> | undefined
  );
  if (!raw) return null;
  const mode = raw.mode === "FILES" ? "FILES" : "TEXT";
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map((a) => String(a))
    : [];
  return { mode, artifacts };
}

/* ------------- R8 — canonical delivery plan-shape authority ------------- */

/** R8 §3 — PAIR-owned instruction for the goal-bookkeeping task. Its job
 *  is persisting the goal verbatim via worker_spec — the instruction
 *  itself must NEVER echo goal text: the operator's own phrasing
 *  (including a Telegram-delivery request) is payload to be recorded,
 *  not a task directive. */
export const CANONICAL_BOOKKEEPING_INSTRUCTION =
  "Record the mission goal verbatim into mission_goal.txt using the provided worker_spec ops, then reply DONE.";

/** A pure goal-bookkeeping task: its ONLY capability is bookkeeping and
 *  its worker_spec (when declared) only writes mission_goal.txt /
 *  finishes. Anything broader is a real work task and stays subject to
 *  delivery hygiene on its own instruction. */
export function isPureBookkeepingTask(task: Record<string, unknown>): boolean {
  const caps = (task.required_capabilities as string[]) ?? [];
  if (!caps.length || caps.some((c) => String(c) !== BOOKKEEPING_CAP)) return false;
  const spec = (
    (task.metadata as Record<string, unknown> | undefined)
      ?.expected_output_contract as Record<string, unknown> | undefined
  )?.worker_spec as Record<string, unknown> | undefined;
  if (!spec) return true;
  const ops = Array.isArray(spec.ops)
    ? (spec.ops as Array<Record<string, unknown>>)
    : [];
  return ops.every(
    (op) =>
      op?.op === "finish" ||
      (op?.op === "write_text_file" &&
        normalizeArtifactPath(op?.path) === "mission_goal.txt"),
  );
}

/** R8 §3 — PAIR-owned deterministic delivery-preparation contract for
 *  the canonical TELEGRAM_DELIVERY task: the executor ONLY prepares and
 *  stages the authorized deliverable — the governed bridge performs the
 *  external Telegram send after task completion. The instruction never
 *  widens the manifest and never names a destination. */
export function canonicalDeliveryTaskInstruction(
  intent: TelegramDeliveryIntent,
  outputLanguage?: OutputLanguage,
): string {
  const tail =
    "- Do NOT call Telegram, any bot API, or any messaging tool — you have no such authority or tool. " +
    "The external delivery is NOT your job.\n" +
    "- Do not widen the deliverable set and do not pick a destination.\n" +
    "Then reply DONE.";
  if (intent.mode === "FILES") {
    // FILES mode is transport-only: this step stages the manifested
    // producer artifact byte-identically. It NEVER composes, rewrites,
    // translates, or mutates deliverable content — a delivery prep task
    // that rewrites the artifact fails the integrity gate at mint.
    return (
      "You are the governed TELEGRAM_DELIVERY preparation step of this PAIR mission. " +
      "Your job is STAGING ONLY — PAIR's governed bridge performs the external delivery afterwards.\n" +
      `- Manifested artifacts (exact filenames): ${intent.artifacts.join(", ")}.\n` +
      "- Ensure each manifested artifact is present inside outbox/ under its exact manifest " +
      "filename with its content UNCHANGED. When a manifested artifact lives elsewhere in the " +
      "workspace, copy it into outbox/ keeping the filename and byte-identical content — never " +
      "edit, translate, summarize, or regenerate it.\n" +
      "- Never compose a report and never write or modify artifact content yourself. Stage " +
      "exactly the manifested artifacts and nothing else.\n" +
      tail
    );
  }
  // TEXT mode — the canonical payload is the composed report artifact
  // itself; the minted delivery request carries that file's content,
  // never an execution acknowledgement.
  return (
    "You are the governed TELEGRAM_DELIVERY preparation step of this PAIR mission. " +
    "Your job is to PREPARE the deliverable only — PAIR's governed bridge performs " +
    "the external delivery afterwards.\n" +
    "- Read the upstream tasks' returned results in dependency_outputs (provided in your prompt).\n" +
    `- Compose the final operator-facing report as concise plain text in ${languagePhrase(
      outputLanguage?.code ?? null,
    )} and write it to ${DELIVERY_TEXT_ARTIFACT} — that file is the canonical payload the bridge sends.\n` +
    tail
  );
}

/** PAIR-owned language contract line appended to instructions of tasks
 *  that produce a manifested TEXT deliverable — a deterministic stamp,
 *  never planner-derived. Stripped-then-appended so replay is
 *  byte-identical (idempotent). */
const OUTPUT_LANGUAGE_SUFFIX_RE = /\n?PAIR OUTPUT LANGUAGE CONTRACT:[^\n]*\n?/g;

function outputLanguageSuffix(code: string): string {
  return (
    `\nPAIR OUTPUT LANGUAGE CONTRACT: operator-facing deliverable content you produce ` +
    `(the report the operator receives) MUST be written in ${languagePhrase(code)}.`
  );
}

/** R8 §1 — operator-requested Telegram delivery requires EXACTLY ONE
 *  canonical delivery task in the plan. 0 → MISSING; >1 → AMBIGUOUS.
 *  When the operator did NOT request delivery, an emitted delivery task
 *  is unauthorized send authority (the existing INTENT failure). The
 *  operator request is the ONLY delivery authority — file presence,
 *  outbox contents, mission completion, and executor prose never imply
 *  it. */
export function assertDeliveryTaskPresence(
  tasks: Array<Record<string, unknown>>,
  intent: TelegramDeliveryIntent,
): void {
  const count = tasks.filter(isDeliveryTask).length;
  if (intent.requested) {
    if (count === 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_TASK_MISSING",
        JSON.stringify({ requested: true, delivery_tasks: 0 }),
      );
    }
    if (count > 1) {
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS",
        JSON.stringify({ requested: true, delivery_tasks: count }),
      );
    }
    return;
  }
  if (count > 0) {
    throw new IntegrityError(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT",
      JSON.stringify({
        task: String(tasks.find(isDeliveryTask)?.task_key ?? "?"),
      }),
    );
  }
}

/** R8 §2 — instruction hygiene: a task WITHOUT the TELEGRAM_DELIVERY
 *  capability must never carry an affirmative delivery directive. The
 *  SAME clause-scoped intent grammar (delivery verb + Telegram mention
 *  within CLAUSE_SPAN, negation-aware, Unicode/Vietnamese-safe) is
 *  reused — "do not send to Telegram"/"không gửi telegram" do not
 *  count as affirmative. */
export function assertTaskDeliveryHygiene(
  tasks: Array<Record<string, unknown>>,
): void {
  for (const t of tasks) {
    if (isDeliveryTask(t)) continue;
    const instruction = String(t.task_instruction ?? "");
    if (!instruction) continue;
    if (detectTelegramDeliveryIntent(instruction).requested) {
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK",
        JSON.stringify({ task: String(t.task_key ?? "?") }),
      );
    }
  }
}

/** R8 §4 — pre-dispatch semantic defense: affirmative Telegram delivery
 *  semantics in task_instruction ⇒ the TASK must require
 *  TELEGRAM_DELIVERY. This invariant is about the task's ROLE/
 *  CAPABILITY, never about which executor advertises the capability —
 *  a persisted, bypassed-canonicalization, or malformed plan that
 *  reaches dispatch carrying a send directive on a non-delivery task
 *  fails closed with zero executor dispatch. */
export function assertTaskDeliverySemantic(
  task: Record<string, unknown>,
): void {
  if (isDeliveryTask(task)) return;
  const instruction = String(task.task_instruction ?? "");
  if (instruction && detectTelegramDeliveryIntent(instruction).requested) {
    throw new IntegrityError(
      "FAIL_CLOSED_TASK_DELIVERY_SEMANTIC_MISMATCH",
      JSON.stringify({
        task: String(task.task_key ?? task.task_id ?? "?"),
      }),
    );
  }
}

/**
 * The canonical per-task artifact model: structured worker_spec ops ∪
 * verb-attributed instruction paths ∪ declared pair_dataflow — all
 * normalized, deduped, sorted. Remote tasks carry no local artifact I/O.
 * Unsafe declared paths fail closed.
 */
export function extractTaskDataflow(task: Record<string, unknown>): TaskDataflow {
  // F2 §20 — remote tasks now carry dataflow names: their produces are
  // the canonical ART logical names and their consumes are governed by
  // the artifact handoff contract (acread fetch), both resolved only to
  // F1-validated canonical artifacts. The fail-closed counterpart is in
  // assertPlanDataflow: a remote task listed in depends_on must be bound
  // by an explicitly declared consume edge — undeclared remote coupling
  // still fails.

  const c = contractArtifacts(task);
  const i = instructionArtifacts(task);
  const d = declaredArtifacts(task);
  const produces = new Set([...c.produces, ...i.produces]);
  const consumes = new Set([...c.consumes, ...i.consumes]);
  // PAIR-stamped delivery manifest: the delivery task consumes the exact
  // manifested artifacts (it must read/stage them) and produces the
  // staged outbox copy. Only PAIR writes this field — planner versions
  // are stripped before extraction.
  const manifest = isDeliveryTask(task) ? deliveryManifest(task) : null;
  if (manifest) {
    for (const a of manifest.artifacts) {
      const n = normalizeArtifactPath(a);
      if (!n) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_PATH",
          `${String(task.task_key ?? "?")}:${String(a).slice(0, 80)}`,
        );
      }
      consumes.add(n);
      // FILES-mode delivery stages the deliverable into outbox/ — but a
      // manifest name already outbox/-prefixed is the deliverable itself,
      // so adding it as a produce would shadow its own consume edge.
      if (manifest.mode === "FILES" && !n.startsWith("outbox/")) {
        produces.add(`outbox/${path.posix.basename(n)}`);
      }
    }
    // F4.4 — a TEXT-mode delivery execution genuinely writes the
    // canonical payload file (outbox/report.txt): declare it so the
    // execution's own artifact ingest can bind the payload to THIS
    // execution — "report.txt exists" is never proof; its canonical
    // artifact under the current execution is.
    if (manifest.mode === "TEXT") {
      produces.add(DELIVERY_TEXT_ARTIFACT);
    }
  }
  for (const p of [...d.produces, ...d.consumes]) {
    const n = normalizeArtifactPath(p);
    if (!n) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_PATH",
        `${String(task.task_key ?? "?")}:${String(p).slice(0, 80)}`,
      );
    }
  }
  for (const p of d.produces) produces.add(normalizeArtifactPath(p)!);
  for (const p of d.consumes) consumes.add(normalizeArtifactPath(p)!);
  if (produces.size > MAX_ARTIFACTS_PER_TASK || consumes.size > MAX_ARTIFACTS_PER_TASK) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_DATAFLOW_BOUNDS",
      `${String(task.task_key ?? "?")}`,
    );
  }
  return {
    produces: [...produces].sort(),
    consumes: [...consumes].sort(),
  };
}

/** HOTFIX-A — the consume names carrying a canonical external-source
 *  binding on this task (the PAIR-stamped pair_dataflow_sources ledger).
 *  Entries are never trusted as authority themselves: they only exempt
 *  a consume from the in-plan-producer rule; the binding they claim is
 *  fully re-proven against durable authority before any byte moves. */
export function externalSourceBoundConsumes(
  task: Record<string, unknown>,
): Set<string> {
  const md = task.metadata as Record<string, unknown> | undefined;
  const rows = md?.[PAIR_DATAFLOW_SOURCES];
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const name = normalizeArtifactPath(
      (r as Record<string, unknown>)?.consume_name,
    );
    if (name) out.add(name);
  }
  return out;
}

/**
 * HOTFIX-A — cross-mission input binding at THE canonical seams.
 *
 * For every task's declared consumes, any artifact with NO producer
 * inside this plan's task array is resolved against the bounded
 * `sources` set — canonical ACCEPTED artifacts the consumer mission's
 * authorized lineage makes eligible (computed by trusted PAIR code,
 * never from planner fields):
 *
 *   - exactly one eligible artifact (canonical name-equivalence) →
 *     stamp `pair_dataflow_sources` pinning consume_name + the
 *     immutable source identity (artifact_id, sha256, byte_size,
 *     source mission/task/governed/execution/executor);
 *   - zero matches → consume stays unbound: requiredEdges emits the
 *     ordinary FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT;
 *   - >1 distinct artifact identities → FAIL_CLOSED ambiguous source;
 *     a consume name can never pick lexically between artifacts.
 *
 * A consume the plan ALSO produces in-plan keeps its in-plan producer
 * edge — an external source never displaces same-mission provenance,
 * and a stamped entry on a self-produced consume is a contradiction
 * (fail closed). Idempotent: re-running on an already-stamped list
 * recomputes the identical ledger (or fails on conflict).
 */
export function bindPlanExternalInputs(
  tasks: Array<Record<string, unknown>>,
  sources: ExternalInputArtifactSource[],
): void {
  const producerIndex = new Map<string, number>();
  for (const [i, t] of tasks.entries()) {
    for (const p of extractTaskDataflow(t).produces) {
      if (!producerIndex.has(p)) producerIndex.set(p, i);
    }
  }
  for (const [i, task] of tasks.entries()) {
    const model = extractTaskDataflow(task);
    const produces = new Set(model.produces);
    const bound: Array<Record<string, unknown>> = [];
    for (const rawName of model.consumes) {
      const name = normalizeArtifactPath(rawName);
      if (!name) continue;
      if (produces.has(name)) {
        // R3-F4 — a consume colliding with the task's OWN produces can
        // never prove it meant the external artifact rather than its own
        // output (a task cannot consume a file it has not yet written):
        // while an eligible source with that logical name exists the
        // intent is unresolvable — fail closed instead of silently
        // shadowing the upstream artifact. Explicit external intents are
        // declared through the identity-pinned alias, never this name.
        const shadowed = sources.some(
          (s) =>
            s.logical_name === name ||
            artifactNamesEquivalentCompat(s.logical_name, name),
        );
        if (shadowed) {
          throw new IntegrityError(
            "FAIL_CLOSED_PLAN_DATAFLOW_SHADOWED_SOURCE",
            JSON.stringify({
              task: String(task.task_key ?? ""),
              artifact: name,
            }),
          );
        }
        continue;
      }
      if (producerIndex.has(name)) continue; // in-plan producer owns it
      const matches = new Map<string, ExternalInputArtifactSource>();
      // R3-F5 — an identity-pinned alias consume resolves its source by
      // artifact_id directly (the declaration is unambiguous by
      // construction); an ordinary logical-name consume resolves by the
      // canonical name-equivalence rule, never by filename heuristics.
      const aliasMatch = EXTERNAL_CONSUME_ALIAS_RE.exec(name);
      if (aliasMatch) {
        for (const s of sources) {
          if (s.artifact_id === aliasMatch[1]) matches.set(s.artifact_id, s);
        }
      } else {
        for (const s of sources) {
          // The consume name must equal the canonical logical name —
          // eligibility by identity, never by filename heuristics alone.
          if (s.logical_name === name || artifactNamesEquivalentCompat(s.logical_name, name)) {
            if (!matches.has(s.artifact_id)) matches.set(s.artifact_id, s);
          }
        }
      }
      if (matches.size > 1) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_SOURCE",
          JSON.stringify({ task: String(task.task_key ?? ""), artifact: name }),
        );
      }
      const src = [...matches.values()][0];
      if (!src) continue; // stays unbound — requiredEdges fails it
      bound.push({
        contract: EXTERNAL_INPUT_CONTRACT,
        consume_name: name,
        artifact_id: src.artifact_id,
        logical_name: src.logical_name,
        sha256: src.sha256,
        byte_size: src.byte_size,
        source_mission_id: src.source_mission_id,
        source_task_id: src.source_task_id,
        source_governed_task_id: src.source_governed_task_id,
        source_execution_id: src.source_execution_id,
        source_executor_id: src.source_executor_id,
      });
    }
    const md = (task.metadata ??= {}) as Record<string, unknown>;
    const prev = md[PAIR_DATAFLOW_SOURCES];
    if (prev !== undefined) {
      // Replay/idempotency: a prior stamp must equal the recomputed
      // ledger byte-for-byte — drift means the binding context moved
      // and the plan must be re-planned, never silently re-pinned.
      if (canonicalJson(prev) !== canonicalJson(bound)) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
          JSON.stringify({ task: String(task.task_key ?? "") }),
        );
      }
    } else if (bound.length) {
      md[PAIR_DATAFLOW_SOURCES] = bound;
    }
  }
}

/** Local equivalence shim — the canonical spelling rule lives in
 *  artifact-authority (imported lazily-free: this module must stay
 *  dependency-light; the rule is the X ≡ outbox/<basename> pair). */
function artifactNamesEquivalentCompat(a: string, b: string): boolean {
  if (a === b) return true;
  const base = (n: string) => n.split("/").pop() ?? n;
  return (
    (a.startsWith("outbox/") && a === `outbox/${base(b)}`) ||
    (b.startsWith("outbox/") && b === `outbox/${base(a)}`)
  );
}

/** HOTFIX-A — structural proof for stamped external bindings on an
 *  already-canonical task list: every stamped entry must be well-formed
 *  (all immutable identity fields present, consume_name declared in the
 *  task's consumes) and must not collide with an in-plan producer (a
 *  double-bound artifact is forged/stale authority). Full eligibility
 *  and byte integrity are re-proven at dispatch resolution — this check
 *  only rejects malformed/unsound stamped shapes. */
function assertExternalSourceStamps(
  tasks: Array<Record<string, unknown>>,
  models: TaskDataflow[],
): void {
  const producedBy = new Map<string, number>();
  for (const [i, m] of models.entries()) {
    for (const p of m.produces) {
      if (!producedBy.has(p)) producedBy.set(p, i);
    }
  }
  for (const [i, task] of tasks.entries()) {
    const md = task.metadata as Record<string, unknown> | undefined;
    const rows = md?.[PAIR_DATAFLOW_SOURCES];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
        JSON.stringify({ task: String(task.task_key ?? ""), malformed: true }),
      );
    }
    const consumes = new Set(models[i].consumes);
    const seen = new Set<string>();
    for (const r of rows) {
      const e = r as Record<string, unknown>;
      const name = normalizeArtifactPath(e?.consume_name);
      const fieldsOk =
        name &&
        typeof e.artifact_id === "string" && e.artifact_id.length > 0 &&
        typeof e.logical_name === "string" && e.logical_name.length > 0 &&
        typeof e.sha256 === "string" && e.sha256.length > 0 &&
        Number.isInteger(Number(e.byte_size)) && Number(e.byte_size) >= 0 &&
        typeof e.source_mission_id === "string" && e.source_mission_id.length > 0 &&
        typeof e.source_task_id === "string" && e.source_task_id.length > 0 &&
        typeof e.source_governed_task_id === "string" && e.source_governed_task_id.length > 0 &&
        typeof e.source_execution_id === "string" && e.source_execution_id.length > 0 &&
        typeof e.source_executor_id === "string" && e.source_executor_id.length > 0;
      if (!fieldsOk || !consumes.has(name!)) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
          JSON.stringify({ task: String(task.task_key ?? ""), malformed: true }),
        );
      }
      if (seen.has(name!)) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
          JSON.stringify({ task: String(task.task_key ?? ""), duplicate: name }),
        );
      }
      seen.add(name!);
      const producerIdx = producedBy.get(name!);
      if (producerIdx !== undefined && producerIdx !== i) {
        // The artifact has a real in-plan producer — an external stamp
        // on top is a contradiction (stale or forged authority).
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
          JSON.stringify({ task: String(task.task_key ?? ""), double_bound: name }),
        );
      }
    }
  }
}

/**
 * For each task, the set of task_keys it MUST depend on under the
 * data-flow rules: the unique earlier producer of every consumed artifact
 * plus — for TELEGRAM_DELIVERY — every other task (the delivery step is
 * the plan's terminal report; it consumes all upstream result text via
 * dependency_outputs). Throws typed plan errors on unbound/ambiguous/
 * backward producers.
 */
function requiredEdges(
  tasks: Array<Record<string, unknown>>,
  models: TaskDataflow[],
): Array<{ producerIndex: number; artifact: string }>[] {
  const indexByArtifact = new Map<string, number[]>();
  for (const [i, m] of models.entries()) {
    for (const p of m.produces) {
      const arr = indexByArtifact.get(p) ?? [];
      arr.push(i);
      indexByArtifact.set(p, arr);
    }
  }
  const out: Array<{ producerIndex: number; artifact: string }[]> = tasks.map(
    () => [],
  );
  const indexByKey = new Map(
    tasks.map((t, j) => [String(t.task_key), j] as const),
  );
  for (const [i, task] of tasks.entries()) {
    const key = String(task.task_key ?? "");
    const model = models[i];
    const manifest = isDeliveryTask(task) ? deliveryManifest(task) : null;
    const manifestNames = new Set(
      (manifest?.artifacts ?? [])
        .map((a) => normalizeArtifactPath(a))
        .filter((a): a is string => a !== null),
    );
    // Self-produced artifacts are normally excluded — but a manifest
    // artifact must ALWAYS bind its producer (the delivery stages a copy;
    // the instruction-grammar may also name it as a produce).
    // HOTFIX-A — a consume carrying a canonical PAIR-stamped external
    // source binding is an authorized cross-mission input, NOT an in-plan
    // producer dependency: it never requires an earlier producer edge.
    const sourceBound = externalSourceBoundConsumes(task);
    const needed = model.consumes.filter(
      (a) =>
        (!model.produces.includes(a) || manifestNames.has(a)) &&
        !sourceBound.has(a),
    );
    for (const artifact of needed) {
      // Manifest artifacts bind producers of the named file OR of its
      // staged outbox copy — both name the same deliverable.
      const candidates =
        manifestNames.has(artifact) && !artifact.startsWith("outbox/")
          ? [artifact, `outbox/${path.posix.basename(artifact)}`]
          : [artifact];
      const producers = [
        ...new Set(
          candidates.flatMap((c) => indexByArtifact.get(c) ?? []),
        ),
      ].filter((j) => j !== i);
      const earlier = producers.filter((j) => j < i);
      if (producers.length === 0) {
        // F4.2 — a manifested artifact without any declared producer is
        // UNBOUND, full stop: remote tasks are producers only through an
        // explicit declared produce edge, never by mere precedence.
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT",
          JSON.stringify({ task: key, artifact }),
        );
      }
      if (earlier.length === 0) {
        // Producer exists only later — repairing would mean reordering on a
        // guess, which is never allowed.
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_ORDER",
          JSON.stringify({ task: key, artifact }),
        );
      }
      if (earlier.length > 1) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER",
          JSON.stringify({ task: key, artifact }),
        );
      }
      out[i].push({ producerIndex: earlier[0], artifact });
    }
    if (isDeliveryTask(task)) {
      // A TELEGRAM_DELIVERY task is a DAG leaf: it may depend ONLY on
      // valid earlier producers — of the manifested artifacts, and (TEXT
      // mode) of the result text of earlier content-bearing tasks. A
      // delivery task without the PAIR-stamped manifest carries no
      // governed send authority and fails closed; a needed producer
      // placed later is an ORDER failure, never a forward-edge repair.
      if (!manifest) {
        throw new IntegrityError(
          "FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT",
          JSON.stringify({ task: key }),
        );
      }
      if (manifest.mode === "TEXT") {
        const content = tasks
          .map((t, j) => (j < i && isContentBearing(t) ? j : -1))
          .filter((j) => j >= 0);
        if (!content.length) {
          // R2-F1 — a TEXT-mode delivery with no content-bearing
          // upstream has no legitimate payload to compose: the task
          // would fabricate the operator-facing report from nothing.
          // Fail closed as an unbound RESULT_TEXT input (same class as
          // a manifested artifact without a producer).
          throw new IntegrityError(
            "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT",
            JSON.stringify({ task: key, artifact: "RESULT_TEXT" }),
          );
        }
        for (const j of content) {
          out[i].push({ producerIndex: j, artifact: "RESULT_TEXT" });
        }
      }
      // F4.2 — the remote-predecessor inference is REMOVED: an earlier
      // remote task that never declared the artifact cannot be its
      // producer (PAIROutboxUpload implicit binding is gone). A
      // manifested artifact's legitimate producer was already bound by
      // the declared-produce pass above; every remaining unbound
      // manifest artifact reached the UNBOUND throw there.
    }
    // F2 §20 — DAG-LEAF NARROWING: a remote task listed in depends_on
    // must be bound by an explicitly declared consume edge resolved in
    // this loop. Remote coupling with no governed artifact edge can
    // never become a canonical handoff, so it remains rejected like any
    // undeclared dependency.
    if (!isDeliveryTask(task)) {
      for (const dep of (task.depends_on as string[] | undefined) ?? []) {
        const j = indexByKey.get(String(dep));
        if (j === undefined || j === i) continue;
        if (!isRemoteTask(tasks[j])) continue;
        if (!out[i].some((r) => r.producerIndex === j)) {
          throw new IntegrityError(
            "FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE",
            JSON.stringify({ task: key, depends_on: String(dep) }),
          );
        }
      }
    }
  }
  return out;
}

/** depends_on normalized: declared deps + required edges, deduped, ordered
 *  by plan position (unknown refs keep their place at the end so the
 *  downstream validator still rejects them). */
function normalizedDeps(
  declared: string[],
  required: Array<{ producerIndex: number; artifact: string }>,
  tasks: Array<Record<string, unknown>>,
): string[] {
  const indexByKey = new Map(
    tasks.map((t, i) => [String(t.task_key), i] as const),
  );
  const requiredKeys = new Set(
    required.map((r) => String(tasks[r.producerIndex].task_key)),
  );
  const all = new Set([...declared.map(String), ...requiredKeys]);
  return [...all].sort((a, b) => {
    const ia = indexByKey.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = indexByKey.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib || a.localeCompare(b);
  });
}

/** R2 §5 — a TELEGRAM_DELIVERY task is a DAG leaf: NOTHING may declare
 *  a dependency on it. A forward edge out of delivery is an ORDER
 *  failure — never silently reordered or serialized. */
function assertDeliveryLeaves(
  tasks: Array<Record<string, unknown>>,
  depsByKey: Map<string, string[]>,
): void {
  const deliveryKeys = new Set(
    tasks.filter(isDeliveryTask).map((t) => String(t.task_key)),
  );
  if (!deliveryKeys.size) return;
  for (const [key, deps] of depsByKey) {
    if (deliveryKeys.has(key)) continue;
    if (deps.some((d) => deliveryKeys.has(d))) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_ORDER",
        JSON.stringify({ task: key, forward_edge_to_delivery: true }),
      );
    }
  }
}

/** Deterministic acyclicity check over task_key edges. */
function assertAcyclic(depsByKey: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (k: string, trail: string[]): void => {
    if (visiting.has(k)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_ORDER",
        `cycle:${[...trail, k].join("->")}`,
      );
    }
    if (visited.has(k)) return;
    visiting.add(k);
    for (const d of depsByKey.get(k) ?? []) visit(d, [...trail, k]);
    visiting.delete(k);
    visited.add(k);
  };
  for (const k of depsByKey.keys()) visit(k, []);
}

/**
 * Repair a canonical task list in place: persist `metadata.pair_dataflow`
 * on every task and inject missing producer edges with durable repair
 * evidence (`metadata.pair_dataflow_repairs`). Idempotent — reconciling an
 * already-repaired list produces the byte-identical list.
 *
 * Returns the SAME array (mutated) plus the repair ledger.
 */
export interface ReconcileOptions {
  /** Operator-request authority — when omitted the plan cannot carry a
   *  TELEGRAM_DELIVERY task (it fails closed on INTENT). */
  telegramIntent?: TelegramDeliveryIntent;
  /** HOTFIX-A — the bounded set of canonical ACCEPTED artifacts this
   *  plan's mission may consume cross-mission, resolved by trusted PAIR
   *  code from the mission's authorized lineage. Unproduced consumes
   *  matching exactly one entry bind it (PAIR-stamped); zero matches
   *  stay ordinary unbound inputs; >1 fails closed ambiguous. */
  external_input_artifacts?: ExternalInputArtifactSource[];
  /** Canonical output-language authority derived from the effective
   *  operator goal. Stamped onto the delivery task's reserved metadata
   *  (digest-covered) and injected into manifested-artifact producer
   *  instructions. Omitted → UNDETERMINED. */
  outputLanguage?: OutputLanguage;
  /** R3 — PAIR-owned declarations "task_key consumes eligible input
   *  artifact_id". Minted only by trusted PAIR code (the template
   *  fallback) and carried through the options object — never through
   *  task metadata, so planner-controlled fields can never mint or
   *  forge a declaration. Each entry resolves its source strictly by
   *  artifact_id inside the bounded eligible set (unresolvable → fail
   *  closed) and is folded into the task's canonical consume
   *  declarations BEFORE any model extraction: an explicit,
   *  deterministic mapping from authorized eligible identities to
   *  consume declarations — never inferred by parsing instruction
   *  prose. */
  declared_external_inputs?: DeclaredExternalInput[];
}

/** R3 — fold PAIR-owned external-input declarations into each task's
 *  canonical consume declarations BEFORE any dataflow model is
 *  extracted. Runs after the reserved-metadata strip, so what is folded
 *  here is provably PAIR-authored: the declaration arrives through
 *  `ReconcileOptions`, never through a task field.
 *
 *  Resolution rules (deterministic, fail-closed):
 *   - `task_key` must name an existing task and `artifact_id` an entry
 *     of the bounded eligible set — otherwise the declaration is stale
 *     or forged and planning fails closed.
 *   - consume_name = the canonical `logical_name` verbatim whenever the
 *     plan-dataflow path grammar can express it AND no task in the plan
 *     produces that name (an in-plan produce can never shadow an
 *     external input — R3-F4).
 *   - otherwise the identity-pinned `externalConsumeAlias` — unambiguous
 *     by construction, still bound by artifact_id, materialized under
 *     the real logical_name.
 *
 *  `inherited` re-injects consume names already proven by a prior
 *  stamped ledger (re-canonicalized plans stay byte-identical). */
function applyDeclaredExternalInputs(
  tasks: Array<Record<string, unknown>>,
  sources: ExternalInputArtifactSource[],
  declared: DeclaredExternalInput[] | undefined,
  inherited: Map<number, string[]>,
): void {
  const produced = new Set<string>();
  for (const t of tasks) {
    for (const p of extractTaskDataflow(t).produces) produced.add(p);
  }
  const add = (task: Record<string, unknown>, name: string) => {
    const md = (task.metadata ??= {}) as Record<string, unknown>;
    const df = (md.pair_dataflow ??= {}) as Record<string, unknown>;
    const cons = Array.isArray(df.consumes)
      ? (df.consumes as string[])
      : (df.consumes = [] as string[]);
    if (!cons.includes(name)) cons.push(name);
  };
  const byKey = new Map<string, Record<string, unknown>>();
  for (const t of tasks) byKey.set(String(t.task_key ?? ""), t);
  for (const d of declared ?? []) {
    const task = byKey.get(String(d.task_key));
    const src = sources.find((s) => s.artifact_id === d.artifact_id);
    if (!task || !src) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT",
        JSON.stringify({
          task: String(d.task_key ?? ""),
          artifact_id: String(d.artifact_id ?? ""),
          reason: "declared input not an eligible source",
        }),
      );
    }
    // CAS identity sanity (same contract as artifact-authority's
    // normalizeArtifactName): a logical_name carrying traversal,
    // absolute, backslash or control bytes could never be minted — a
    // source carrying one is forged/stale, and materializing it would
    // widen the workspace path. Reject, never bind.
    {
      const ln = String(src.logical_name ?? "");
      const segs = ln.split("/");
      const unsafe =
        !ln ||
        /[\0-\x1f\\]/.test(ln) ||
        path.isAbsolute(ln) ||
        segs.some((s) => s === "" || s === "." || s === "..");
      if (unsafe) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT",
          JSON.stringify({
            task: String(d.task_key ?? ""),
            artifact_id: String(d.artifact_id ?? ""),
            reason: "unsafe logical_name",
          }),
        );
      }
    }
    const rep = normalizeArtifactPath(src.logical_name);
    const name =
      rep && !produced.has(rep) ? rep : externalConsumeAlias(src.artifact_id);
    if (!normalizeArtifactPath(name)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT",
        JSON.stringify({
          task: String(d.task_key ?? ""),
          artifact_id: String(d.artifact_id ?? ""),
          reason: "no representable consume name",
        }),
      );
    }
    add(task, name);
  }
  for (const [i, names] of inherited) {
    const task = tasks[i];
    if (!task) continue;
    for (const n of names) add(task, n);
  }
}

export function reconcilePlanDataflow(
  tasks: Array<Record<string, unknown>>,
  opts: ReconcileOptions = {},
): { tasks: Array<Record<string, unknown>>; repairs: DataflowRepair[] } {
  // R3 — consume names a PAIR-stamped binding ledger already proved on
  // a previous canonical pass: captured BEFORE the reserved-metadata
  // strip so re-reconciling a canonical list re-derives the identical
  // consume set (a forged ledger can only declare consume INTENT —
  // binding still re-proves the artifact against the bounded eligible
  // set by identity, so preservation grants no source authority).
  const inheritedConsumes = new Map<number, string[]>();
  for (const [i, t] of tasks.entries()) {
    const rows = (
      (t?.metadata as Record<string, unknown> | undefined)?.[
        PAIR_DATAFLOW_SOURCES
      ]
    ) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const n = normalizeArtifactPath(r?.consume_name);
      if (n) (inheritedConsumes.get(i) ?? inheritedConsumes.set(i, []).get(i)!).push(n);
    }
  }
  // R2 §11 — PAIR-reserved fields are stripped from raw planner output
  // before any extraction: planner metadata never mints data-flow,
  // repair, or delivery authority. Re-running on an already-canonical
  // list strips the PAIR-stamped values and recomputes them identically
  // (idempotent).
  stripReservedTaskMetadata(tasks);
  applyDeclaredExternalInputs(
    tasks,
    opts.external_input_artifacts ?? [],
    opts.declared_external_inputs,
    inheritedConsumes,
  );
  const intent: TelegramDeliveryIntent = opts.telegramIntent ?? {
    requested: false,
    artifacts: [],
    mode: "TEXT",
  };
  // R8 §1 — the intent↔presence invariant at THE canonical seam, before
  // a planner candidate can become the failover winner: an operator
  // request for Telegram delivery requires EXACTLY ONE canonical
  // delivery task; an emitted delivery task without the request is
  // unauthorized send authority.
  assertDeliveryTaskPresence(tasks, intent);
  for (const t of tasks) {
    // R8 §3 — pure bookkeeping instruction is PAIR-owned so operator
    // goal phrasing can never be misread as a task directive (the goal
    // text itself may carry the send request).
    if (isPureBookkeepingTask(t)) {
      t.task_instruction = CANONICAL_BOOKKEEPING_INSTRUCTION;
    }
  }
  const outputLanguage: OutputLanguage = opts.outputLanguage ?? {
    code: null,
    authority: "UNDETERMINED",
    evidence: { detector: "authority_unavailable" },
  };
  for (const t of tasks) {
    if (!isDeliveryTask(t)) continue;
    const md = (t.metadata ??= {}) as Record<string, unknown>;
    md[TELEGRAM_MANIFEST_FIELD] = {
      requested: true,
      mode: intent.mode,
      artifacts: [...intent.artifacts],
    };
    // Canonical output-language authority — stamped by PAIR from the
    // effective operator goal, never from planner metadata (the key is
    // reserved and stripped before this). Digest-covered through the
    // pinned canonical task list; replay-verified at every assert
    // boundary; re-derived from the goal at the delivery gate, so a
    // tampered stamp cannot move runtime authority. Stamped ONLY when
    // the caller proved the goal's authority — a reconcile without it
    // leaves the key absent rather than minting a guessed one.
    if (opts.outputLanguage !== undefined) {
      // R1.3 — the contract marker mints the plan-contract version at
      // the same seam: its presence converts the language stamp from
      // tolerated-absent (legacy) into REQUIRED (new-contract plan).
      md[PAIR_PLAN_CONTRACT_KEY] = { version: PAIR_PLAN_CONTRACT_VERSION };
      md[PAIR_OUTPUT_LANGUAGE_KEY] = outputLanguage;
    }
    // R8 §3 — PAIR-owned deterministic delivery-preparation contract:
    // the task stages the deliverable; the governed bridge sends.
    t.task_instruction = canonicalDeliveryTaskInstruction(intent, outputLanguage);
  }
  // R8 §2 — a non-delivery task carrying an affirmative delivery clause
  // makes the whole plan invalid at the canonical seam (failover picks
  // a valid candidate rather than normalizing silently).
  assertTaskDeliveryHygiene(tasks);
  const models = tasks.map((t) => extractTaskDataflow(t));
  // HOTFIX-A — bind authorized cross-mission inputs BEFORE edge
  // resolution: an unproduced consume that resolves to exactly one
  // eligible canonical artifact is stamped (digest-covered); an
  // unmatched consume stays an ordinary unbound input and fails below.
  bindPlanExternalInputs(tasks, opts.external_input_artifacts ?? []);
  const required = requiredEdges(tasks, models);
  // Output-language authority propagates to the producers of manifested
  // TEXT deliverables — a FILES-mode report written upstream must be
  // composed in the canonical language. Only declared artifact
  // producers get the stamp; RESULT_TEXT intermediates keep the
  // language freedom of mandate E.
  if (outputLanguage.code) {
    const suffix = outputLanguageSuffix(outputLanguage.code);
    for (const [i, task] of tasks.entries()) {
      if (!isDeliveryTask(task)) continue;
      const producerIdx = new Set<number>();
      for (const r of required[i]) {
        if (r.artifact === "RESULT_TEXT") continue;
        if (!isTextDeliverableName(r.artifact)) continue;
        producerIdx.add(r.producerIndex);
      }
      for (const j of producerIdx) {
        const ins = String(tasks[j].task_instruction ?? "");
        tasks[j].task_instruction =
          ins.replace(OUTPUT_LANGUAGE_SUFFIX_RE, "").replace(/\n+$/, "") + suffix;
      }
    }
  }
  const repairs: DataflowRepair[] = [];
  const depsByKey = new Map<string, string[]>();
  for (const [i, task] of tasks.entries()) {
    const declared = Array.isArray(task.depends_on)
      ? (task.depends_on as string[]).map(String)
      : [];
    const next = normalizedDeps(declared, required[i], tasks);
    const md = (task.metadata ??= {}) as Record<string, unknown>;
    // The planner's ORIGINAL declared deps are stamped once and kept —
    // the repair ledger recomputes identically on replay (byte-identical
    // canonical tasks, R2 §11).
    const origDeps = Array.isArray(md[PAIR_DATAFLOW_ORIGINAL_DEPS])
      ? (md[PAIR_DATAFLOW_ORIGINAL_DEPS] as string[]).map(String)
      : declared;
    const added = next.filter((k) => !origDeps.includes(k));
    // Canonical key order: delete + re-set so replay produces the same
    // byte ordering regardless of pre-existing stamped fields.
    const manifest = md[TELEGRAM_MANIFEST_FIELD];
    const outLang = md[PAIR_OUTPUT_LANGUAGE_KEY];
    const planContract = md[PAIR_PLAN_CONTRACT_KEY];
    delete md[PAIR_DATAFLOW_ORIGINAL_DEPS];
    delete md[TELEGRAM_MANIFEST_FIELD];
    delete md[PAIR_OUTPUT_LANGUAGE_KEY];
    delete md[PAIR_PLAN_CONTRACT_KEY];
    md[PAIR_DATAFLOW_ORIGINAL_DEPS] = origDeps;
    md.pair_dataflow = models[i];
    if (manifest !== undefined) md[TELEGRAM_MANIFEST_FIELD] = manifest;
    if (planContract !== undefined) md[PAIR_PLAN_CONTRACT_KEY] = planContract;
    if (outLang !== undefined) md[PAIR_OUTPUT_LANGUAGE_KEY] = outLang;
    if (added.length) {
      task.depends_on = next;
      for (const producerKey of added) {
        // First required entry for this producer wins — real artifacts are
        // pushed before RESULT_TEXT delivery edges.
        const req = required[i].find(
          (r) => String(tasks[r.producerIndex].task_key) === producerKey,
        );
        repairs.push({
          consumer_key: String(task.task_key),
          producer_key: producerKey,
          artifact: req?.artifact ?? "RESULT_TEXT",
          reason: "ARTIFACT_DATAFLOW",
          original_depends_on: origDeps,
          resulting_depends_on: next,
        });
      }
    }
    depsByKey.set(String(task.task_key), next);
  }
  if (repairs.length) {
    // One ledger row per consumer task keeps evidence flat and digested.
    const byConsumer = new Map<string, DataflowRepair[]>();
    for (const r of repairs) {
      const arr = byConsumer.get(r.consumer_key) ?? [];
      arr.push(r);
      byConsumer.set(r.consumer_key, arr);
    }
    for (const [key, rs] of byConsumer) {
      const task = tasks.find((t) => String(t.task_key) === key)!;
      (task.metadata as Record<string, unknown>).pair_dataflow_repairs = rs;
    }
  }
  assertAcyclic(depsByKey);
  assertDeliveryLeaves(tasks, depsByKey);
  return { tasks, repairs };
}

/**
 * Pure validation — never mutates. Replays the data-flow rules on an
 * already-canonical task list (preview pin, confirm replay, replan,
 * runtime planning): any required edge that is missing, or any consumed
 * artifact that has no unique earlier producer, fails closed. A legacy
 * READY preview carrying an unsound DAG therefore rejects at confirm
 * instead of minting a mission.
 */
export interface AssertPlanDataflowOptions {
  /** Operator-request authority when the caller can prove it (the
   *  effective goal) — re-proves the R8 §1 intent↔presence invariant at
   *  every immutable-plan boundary (preview pin, confirm, runtime plan
   *  commit, replan). Omitted = presence unprovable; delivery tasks
   *  still require the PAIR-stamped manifest via the edge rules, and
   *  instruction hygiene ALWAYS runs. */
  telegramIntent?: TelegramDeliveryIntent;
  /** HOTFIX-A — when the caller can prove the eligible cross-mission set,
   *  every stamped external binding must still resolve to a CURRENT
   *  eligible source with the identical pinned identity (revocation/
   *  drift fails closed). Omitted = structural checks only; the dispatch
   *  resolver re-proves authority NOW before any byte is read. */
  external_input_artifacts?: ExternalInputArtifactSource[];
  /** Canonical output-language authority re-derived from the effective
   *  goal: a stamped pair_output_language that differs from the
   *  goal-derived contract — or sits on a non-delivery task — fails
   *  closed (forged/tampered authority). Version gate (R1.3): a
   *  delivery task stamped with the `pair_plan_contract` marker was
   *  canonicalized under this contract — the language stamp is
   *  MANDATORY there and missing fails closed. A delivery task without
   *  the marker is a legacy pre-contract plan: an absent stamp is
   *  still tolerated because runtime re-derives the language from the
   *  mission goal at the delivery gate regardless. */
  outputLanguage?: OutputLanguage;
}

/**
 * The stamped pair_output_language on a delivery task must equal the
 * goal-derived contract byte-for-byte — a different value is tampering,
 * and the reserved key on a non-delivery task is forged authority.
 * R1.3/R2.2 contract gate: `pair_plan_contract {version:2}` is REQUIRED
 * on every delivery task — absent marker, unknown version, or missing
 * stamp all fail closed (forced-replan semantics; marker absence is
 * never treated as legacy provenance). A non-delivery task carrying
 * either reserved key is forged authority.
 */
export function assertOutputLanguageAuthority(
  tasks: Array<Record<string, unknown>>,
  expected: OutputLanguage,
): void {
  const want = canonicalJson(expected);
  for (const t of tasks) {
    const md = t.metadata as Record<string, unknown> | undefined;
    const stamped = md?.[PAIR_OUTPUT_LANGUAGE_KEY] as OutputLanguage | undefined;
    const contract = md?.[PAIR_PLAN_CONTRACT_KEY] as
      | { version?: unknown }
      | undefined;
    if (isDeliveryTask(t)) {
      // R2.2 — every delivery task MUST carry the contract marker.
      // Absence proves nothing about provenance (a bypassed plan looks
      // identical to a pre-contract one), so there is no tolerated
      // absence: reject and force re-plan under the current contract.
      if (contract === undefined) {
        throw new IntegrityError(
          "FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY",
          JSON.stringify({
            task: String(t.task_key ?? "?"),
            missing_plan_contract: true,
          }),
        );
      }
      const v = Number(contract?.version);
      if (!Number.isSafeInteger(v) || v !== PAIR_PLAN_CONTRACT_VERSION) {
        throw new IntegrityError(
          "FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY",
          JSON.stringify({
            task: String(t.task_key ?? "?"),
            unknown_plan_contract: contract ?? null,
          }),
        );
      }
      if (stamped === undefined) {
        throw new IntegrityError(
          "FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY",
          JSON.stringify({
            task: String(t.task_key ?? "?"),
            missing_stamp: true,
            plan_contract: contract,
          }),
        );
      }
      if (stamped !== undefined && canonicalJson(stamped) !== want) {
        throw new IntegrityError(
          "FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY",
          JSON.stringify({
            task: String(t.task_key ?? "?"),
            expected: want,
            stamped: canonicalJson(stamped),
          }),
        );
      }
      continue;
    }
    if (stamped !== undefined || contract !== undefined) {
      throw new IntegrityError(
        "FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY",
        JSON.stringify({ task: String(t.task_key ?? "?"), forged: true }),
      );
    }
  }
}

export function assertPlanDataflow(
  tasks: Array<Record<string, unknown>>,
  opts: AssertPlanDataflowOptions = {},
): void {
  // R8 §1 — re-prove intent↔presence at the persisted-plan boundary
  // when the operator-request authority is known: a READY preview or
  // persisted plan whose delivery shape no longer matches the request
  // fails closed instead of being consumed.
  if (opts.telegramIntent) {
    assertDeliveryTaskPresence(tasks, opts.telegramIntent);
  }
  if (opts.outputLanguage) {
    assertOutputLanguageAuthority(tasks, opts.outputLanguage);
  }
  // R8 §2 — a persisted/bypassed non-delivery task carrying affirmative
  // delivery semantics fails closed at validation, before dispatch.
  assertTaskDeliveryHygiene(tasks);
  // HOTFIX-A — revocation/drift re-proof when the caller holds the
  // eligible-set authority: every stamped source identity must still be
  // exactly one CURRENT eligible artifact. A stale or reshaped binding
  // fails closed; the plan must be re-planned under the live set.
  if (opts.external_input_artifacts) {
    const eligible = new Map(
      opts.external_input_artifacts.map((s) => [s.artifact_id, s]),
    );
    for (const t of tasks) {
      const md = t.metadata as Record<string, unknown> | undefined;
      const rows = md?.[PAIR_DATAFLOW_SOURCES];
      if (!Array.isArray(rows)) continue;
      for (const r of rows as Array<Record<string, unknown>>) {
        const cur = eligible.get(String(r.artifact_id ?? ""));
        if (
          !cur ||
          cur.logical_name !== r.logical_name ||
          cur.sha256 !== r.sha256 ||
          Number(cur.byte_size) !== Number(r.byte_size) ||
          cur.source_mission_id !== r.source_mission_id ||
          cur.source_task_id !== r.source_task_id ||
          cur.source_governed_task_id !== r.source_governed_task_id ||
          cur.source_execution_id !== r.source_execution_id ||
          cur.source_executor_id !== r.source_executor_id
        ) {
          throw new IntegrityError(
            "FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING",
            JSON.stringify({
              task: String(t.task_key ?? ""),
              artifact: String(r.consume_name ?? ""),
              stale: true,
            }),
          );
        }
      }
    }
  }
  assertPlanArtifactStructure(tasks);
}

/**
 * F3 — THE canonical structural artifact/dataflow check shared by the
 * goal-aware assertPlanDataflow and the pure feasibility seam
 * (plan-feasibility.analyzePlanFeasibility). Verifies the executable
 * artifact graph only: every consumed artifact binds exactly one earlier
 * producer, required edges are declared, remote deps carry an explicit
 * governed consume edge, the DAG is acyclic, and delivery tasks stay
 * leaves. Contains NO goal/intent/language authority — those stay in
 * assertPlanDataflow. Structural impossibility only: a missing future
 * artifact is never a violation here.
 */
export function assertPlanArtifactStructure(
  tasks: Array<Record<string, unknown>>,
): void {
  const models = tasks.map((t) => extractTaskDataflow(t));
  // HOTFIX-A — stamped external-source bindings must be well-formed and
  // un-double-bound before they exempt a consume from the producer rule.
  assertExternalSourceStamps(tasks, models);
  const required = requiredEdges(tasks, models);
  const depsByKey = new Map<string, string[]>();
  for (const [i, task] of tasks.entries()) {
    const key = String(task.task_key ?? "");
    const declared = new Set(
      Array.isArray(task.depends_on)
        ? (task.depends_on as string[]).map(String)
        : [],
    );
    for (const r of required[i]) {
      const producerKey = String(tasks[r.producerIndex].task_key);
      if (!declared.has(producerKey)) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND",
          JSON.stringify({ task: key, missing_edge: producerKey, artifact: r.artifact }),
        );
      }
    }
    depsByKey.set(key, [...declared]);
  }
  assertAcyclic(depsByKey);
  assertDeliveryLeaves(tasks, depsByKey);
}

/**
 * Bounded outbox artifact resolution: a canonical consume like
 * `outbox/x.txt` (or a manifest file name) resolves to the exact file
 * OR the unique `<taskPrefix>-<name>` remote-upload variant inside the
 * outbox directory — the same matching the governed delivery resolver
 * uses, never a filesystem guess.
 */
function artifactPresentIn(
  workspace: string,
  artifact: string,
  existsSync: (p: string) => boolean,
  listDirSync: (p: string) => string[],
): boolean {
  const direct = path.join(workspace, artifact);
  if (existsSync(direct)) return true;
  // Remote-upload shape: /api/outbox lands `<taskPrefix>-<filename>`.
  // Match a manifest/consume name against unique prefixed siblings.
  const base = artifact.startsWith("outbox/")
    ? artifact
    : `outbox/${path.posix.basename(artifact)}`;
  const obDir = path.join(workspace, path.posix.dirname(base));
  const name = path.posix.basename(base);
  if (existsSync(path.join(workspace, base))) return true;
  let names: string[] = [];
  try {
    names = listDirSync(obDir);
  } catch {
    return false;
  }
  const matches = names.filter((f) => f.endsWith(`-${name}`));
  return matches.length === 1;
}

/**
 * Pre-dispatch prerequisite seam (R2 §9): proof that a task's canonical
 * consumed input is absent from the workspace BEFORE an executor attempt
 * is spent. Reads ONLY the persisted digested `metadata.pair_dataflow`
 * (never executor prose, never post-execution inference): a task with no
 * declared consumes, or whose consumed artifacts all exist, returns null
 * so dispatch proceeds. `selfProduced` artifacts are skipped (the task
 * writes them itself).
 */
export function missingConsumedArtifact(args: {
  task: Record<string, unknown>;
  workspace: string;
  existsSync?: (p: string) => boolean;
  listDirSync?: (p: string) => string[];
}): { artifact: string } | null {
  const df = (
    (args.task.metadata as Record<string, unknown> | undefined)
      ?.pair_dataflow as Record<string, unknown> | undefined
  );
  const consumes = Array.isArray(df?.consumes)
    ? df.consumes.map((a) => String(a))
    : [];
  if (!consumes.length) return null;
  const produces = new Set(
    Array.isArray(df?.produces) ? df.produces.map((a) => String(a)) : [],
  );
  const exists = args.existsSync ?? ((p: string) => fs.existsSync(p));
  const listDir =
    args.listDirSync ??
    ((p: string) => fs.readdirSync(p).map(String));
  for (const raw of consumes) {
    const artifact = normalizeArtifactPath(raw);
    if (!artifact || produces.has(artifact)) continue;
    if (
      artifactPresentIn(args.workspace, artifact, exists, listDir)
    ) {
      continue;
    }
    return { artifact };
  }
  return null;
}

/** @deprecated R2 — use missingConsumedArtifact (pre-dispatch seam). */
export const provenMissingConsumedArtifact = missingConsumedArtifact;
