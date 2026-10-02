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
 *   provenMissingConsumedArtifact(...)
 *     - evidence-based recovery seam: a FAILED task whose canonical
 *       `consumes` artifact is absent from the workspace is a
 *       deterministic prerequisite failure (DEPENDENCY_FAILURE), never
 *       inferred from executor summary text.
 *
 * Artifact evidence is derived only from authoritative/explicit task
 * material — structured worker_spec ops (read_text_file/write_text_file/
 * append_text_file/delete_file paths), explicit workspace-relative file
 * paths in the canonical instruction attributed by a bounded verb grammar,
 * declared `metadata.pair_dataflow`, and the known delivery contract
 * (TELEGRAM_DELIVERY is the terminal report step — it consumes every
 * upstream result via dependency_outputs and must depend on all other
 * tasks). Remote-capability tasks produce/consume NO workspace artifacts:
 * their files stay remote and only the returned result text flows through
 * dependency_outputs, which the declared edge already covers.
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

// A path token: workspace-relative segments ending in a filename — either
// `name.ext` or an `outbox/` path. The token must not be preceded by a path
// character, so absolute paths like `/home/x/f.txt` never match (the `/`
// before `home` is in the negated class and swallows the whole token).
const PATH_TOKEN =
  /(?:^|[^\w/.-])(outbox\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)?|(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10})(?=$|[^\w/.-])/g;

// Verbs attributing a read/consume role to the following path.
const CONSUME_VERB =
  /\b(?:read|reads|reading|load|loads|cat|consume|consumes|review|summarize|summarise|inspect|check|open|opens|use|uses|using|copy|copies|copying|move|moves|attach|includes?|including|contains|from)\b/i;
// Verbs attributing a write/produce role to the following path.
const PRODUCE_VERB =
  /\b(?:write|writes|writing|create|creates|creating|produce|produces|producing|generate|generates|save|saves|saving|output|outputs|emit|emits|place|places|put|puts|store|stores|persist|persists|upload|uploads)\b/i;
// Destination marker immediately before the path: "to X", "into outbox/X".
const DESTINATION = /\b(?:to|into|onto|inside|in)\s*$/i;

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
 * Bounded instruction-text grammar: a path mention counts only when a
 * sentence verb attributes a role to it. A destination marker immediately
 * before the path (`to`, `into`, `onto`, `in`) wins over read-verbs —
 * "copy X into outbox/Y" consumes X and produces Y. Mentions with no
 * attributed verb are ignored (bounded grammar never guesses).
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
    if (CONSUME_VERB.test(before)) {
      consumes.add(p);
      continue;
    }
    if (PRODUCE_VERB.test(before) || p.startsWith("outbox/")) {
      // Explicit write verbs, or the known outbox contract.
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
    const needed = model.consumes.filter((a) => !model.produces.includes(a));
    for (const artifact of needed) {
      const producers = (indexByArtifact.get(artifact) ?? []).filter(
        (j) => j !== i,
      );
      const earlier = producers.filter((j) => j < i);
      if (producers.length === 0) {
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
      // Delivery consumes every other task's result text via
      // dependency_outputs — it must run strictly last.
      for (const [j] of tasks.entries()) {
        if (j === i) continue;
        out[i].push({ producerIndex: j, artifact: "RESULT_TEXT" });
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
export function reconcilePlanDataflow(
  tasks: Array<Record<string, unknown>>,
): { tasks: Array<Record<string, unknown>>; repairs: DataflowRepair[] } {
  const models = tasks.map((t) => extractTaskDataflow(t));
  const required = requiredEdges(tasks, models);
  const repairs: DataflowRepair[] = [];
  const depsByKey = new Map<string, string[]>();
  for (const [i, task] of tasks.entries()) {
    const declared = Array.isArray(task.depends_on)
      ? (task.depends_on as string[]).map(String)
      : [];
    const next = normalizedDeps(declared, required[i], tasks);
    const added = next.filter((k) => !declared.includes(k));
    const md = (task.metadata ??= {}) as Record<string, unknown>;
    md.pair_dataflow = models[i];
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
          original_depends_on: declared,
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
}

/**
 * Recovery seam — proof that a FAILED task's canonical consumed input is
 * absent from the workspace. Reads ONLY the persisted digested
 * `metadata.pair_dataflow` (never executor prose): a task with no declared
 * consumes, or whose consumed artifacts all exist, returns null so the
 * caller keeps the generic classification. `selfProduced` artifacts are
 * skipped (the task writes them itself).
 */
export function provenMissingConsumedArtifact(args: {
  task: Record<string, unknown>;
  workspace: string;
  existsSync?: (p: string) => boolean;
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
  for (const raw of consumes) {
    const artifact = normalizeArtifactPath(raw);
    if (!artifact || produces.has(artifact)) continue;
    if (exists(path.join(args.workspace, artifact))) continue;
    return { artifact };
  }
  return null;
}
