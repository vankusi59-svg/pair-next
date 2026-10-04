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

const MAX_ARTIFACTS_PER_TASK = 32;
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

export const RESERVED_TASK_METADATA_KEYS = [
  "pair_dataflow",
  "pair_dataflow_repairs",
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
  const mentions: number[] = [];
  let m: RegExpExecArray | null;
  TELEGRAM_MENTION_RE.lastIndex = 0;
  while ((m = TELEGRAM_MENTION_RE.exec(text)) !== null) {
    mentions.push(m.index);
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
    const v = m.index;
    const clause = mentions.some((p) => Math.abs(p - v) <= CLAUSE_SPAN);
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
  /\b(?:read|reads|reading|load|loads|cat|consume|consumes|review|summarize|summarise|inspect|check|open|opens|use|uses|using|copy|copies|copying|move|moves|attach|includes?|including|contains|from)\b/gi;
// Verbs attributing a write/produce role to the following path.
const PRODUCE_VERB =
  /\b(?:write|writes|writing|create|creates|creating|produce|produces|producing|generate|generates|save|saves|saving|output|outputs|emit|emits|place|places|put|puts|store|stores|persist|persists|upload|uploads)\b/gi;
// Destination marker before the path: "to X", "into outbox/X", or the
// marker followed by a bounded run of modifiers — "format the findings
// into a professional report.md" still attributes report.md to the
// destination marker. Bare `in` only counts when adjacent ("in X"), never
// across gap words ("in the process of X").
const DESTINATION =
  /\b(?:(?:to|into|onto|inside)(?:\s+[\w-]+){0,5}\s*|in)\s*$/i;

/** Nearest governing verb before a path mention: the LAST consume/produce
 *  verb inside the bounded lookback window wins — "read input.txt then
 *  generate report.txt" attributes `report.txt` to `generate` (produce),
 *  never to the earlier `read`. Returns null when unattributed. */
function nearestVerbRole(before: string): "consume" | "produce" | null {
  let role: "consume" | "produce" | null = null;
  let m: RegExpExecArray | null;
  CONSUME_VERB.lastIndex = 0;
  let consumeAt = -1;
  while ((m = CONSUME_VERB.exec(before)) !== null) consumeAt = m.index;
  PRODUCE_VERB.lastIndex = 0;
  let produceAt = -1;
  while ((m = PRODUCE_VERB.exec(before)) !== null) produceAt = m.index;
  if (consumeAt < 0 && produceAt < 0) return null;
  role = consumeAt > produceAt ? "consume" : "produce";
  return role;
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
 * attribution, bounded 120-char lookback). A destination marker
 * immediately before the path (`to`, `into`, `onto`, `in`) wins over
 * verbs — "copy X into outbox/Y" consumes X and produces Y. Mentions
 * with no attributed verb are ignored (bounded grammar never guesses).
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
    // Destination marker wins: "copy X into outbox/Y" consumes X, produces Y.
    if (DESTINATION.test(tail)) {
      produces.add(p);
      continue;
    }
    const role = nearestVerbRole(before);
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

const isDeliveryTask = (task: Record<string, unknown>): boolean =>
  ((task.required_capabilities as string[]) ?? []).includes(DELIVERY_CAPABILITY);

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
    const needed = model.consumes.filter(
      (a) => !model.produces.includes(a) || manifestNames.has(a),
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
  /** Canonical output-language authority derived from the effective
   *  operator goal. Stamped onto the delivery task's reserved metadata
   *  (digest-covered) and injected into manifested-artifact producer
   *  instructions. Omitted → UNDETERMINED. */
  outputLanguage?: OutputLanguage;
}

export function reconcilePlanDataflow(
  tasks: Array<Record<string, unknown>>,
  opts: ReconcileOptions = {},
): { tasks: Array<Record<string, unknown>>; repairs: DataflowRepair[] } {
  // R2 §11 — PAIR-reserved fields are stripped from raw planner output
  // before any extraction: planner metadata never mints data-flow,
  // repair, or delivery authority. Re-running on an already-canonical
  // list strips the PAIR-stamped values and recomputes them identically
  // (idempotent).
  stripReservedTaskMetadata(tasks);
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
