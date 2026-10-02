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
 * governed /api/outbox upload is separately modeled as a PAIR_OUTBOX_UPLOAD
 * edge for delivery manifest resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { IntegrityError } from "./errors.js";

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

export const RESERVED_TASK_METADATA_KEYS = [
  "pair_dataflow",
  "pair_dataflow_repairs",
  "pair_telegram_delivery",
  "telegram_delivery",
  "telegram_delivery_requested",
  "telegram_intent",
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
  /(?<![\p{L}\p{N}\p{M}_])(?:send|deliver|forward|share|post|upload|gửi|đẩy|đưa|chuyển|báo|bắn|đăng|đính)(?![\p{L}\p{N}\p{M}_])/giu;
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
// before `home` is in the negated class and swallows the whole token).
const PATH_TOKEN =
  /(?:^|[^\w/.-])(outbox\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)?|(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10})(?=$|[^\w/.-])/g;

// Verbs attributing a read/consume role to the following path.
const CONSUME_VERB =
  /\b(?:read|reads|reading|load|loads|cat|consume|consumes|review|summarize|summarise|inspect|check|open|opens|use|uses|using|copy|copies|copying|move|moves|attach|includes?|including|contains|from)\b/gi;
// Verbs attributing a write/produce role to the following path.
const PRODUCE_VERB =
  /\b(?:write|writes|writing|create|creates|creating|produce|produces|producing|generate|generates|save|saves|saving|output|outputs|emit|emits|place|places|put|puts|store|stores|persist|persists|upload|uploads)\b/gi;
// Destination marker immediately before the path: "to X", "into outbox/X".
const DESTINATION = /\b(?:to|into|onto|inside|in)\s*$/i;

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
    const tail = before.slice(-10);
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

/**
 * The canonical per-task artifact model: structured worker_spec ops ∪
 * verb-attributed instruction paths ∪ declared pair_dataflow — all
 * normalized, deduped, sorted. Remote tasks carry no local artifact I/O.
 * Unsafe declared paths fail closed.
 */
export function extractTaskDataflow(task: Record<string, unknown>): TaskDataflow {
  if (isRemoteTask(task)) return { produces: [], consumes: [] };
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
        // Manifest consumes may still bind to earlier remote uploaders
        // (handled in the delivery block below) — skip the UNBOUND
        // throw for them here.
        if (manifestNames.has(artifact)) continue;
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
      // Manifest artifacts with no local producer bind to earlier remote
      // tasks as PAIR_OUTBOX_UPLOAD producers — a governed upload lands
      // locally only through that remote execution, so delivery must
      // wait for it. A later remote uploader is an ORDER failure.
      for (const artifact of manifestNames) {
        if (out[i].some((r) => r.artifact === artifact)) continue;
        const remoteEarlier = tasks
          .map((t, j) => (j < i && isRemoteTask(t) ? j : -1))
          .filter((j) => j >= 0);
        if (remoteEarlier.length) {
          for (const j of remoteEarlier) {
            out[i].push({
              producerIndex: j,
              artifact: `PAIR_OUTBOX_UPLOAD:${artifact}`,
            });
          }
          continue;
        }
        const remoteLater = tasks
          .map((t, j) => (j > i && isRemoteTask(t) ? j : -1))
          .filter((j) => j >= 0);
        throw new IntegrityError(
          remoteLater.length
            ? "FAIL_CLOSED_PLAN_DATAFLOW_ORDER"
            : "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT",
          JSON.stringify({ task: key, artifact }),
        );
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
  for (const t of tasks) {
    if (!isDeliveryTask(t)) continue;
    if (!intent.requested) {
      // A delivery task with no explicit operator intent must never
      // become send authority — the plan is invalid, failover material.
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT",
        JSON.stringify({ task: String(t.task_key ?? "?") }),
      );
    }
    const md = (t.metadata ??= {}) as Record<string, unknown>;
    md[TELEGRAM_MANIFEST_FIELD] = {
      requested: true,
      mode: intent.mode,
      artifacts: [...intent.artifacts],
    };
  }
  const models = tasks.map((t) => extractTaskDataflow(t));
  const required = requiredEdges(tasks, models);
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
    delete md[PAIR_DATAFLOW_ORIGINAL_DEPS];
    delete md[TELEGRAM_MANIFEST_FIELD];
    md[PAIR_DATAFLOW_ORIGINAL_DEPS] = origDeps;
    md.pair_dataflow = models[i];
    if (manifest !== undefined) md[TELEGRAM_MANIFEST_FIELD] = manifest;
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
export function assertPlanDataflow(
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
