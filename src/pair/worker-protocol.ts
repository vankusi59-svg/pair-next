/**
 * PAIR_WORKER_FILE protocol port (donor standalone_core/worker_protocol.py
 * + executors/subprocess_worker.py).
 *
 * The Automaton PAIR_NATIVE worker kind is `automaton_harness`: a spec-bound
 * harness executes declared ops in-process through LocalWorkerPool, emitting
 * worker_journal.jsonl op events and a canonical result.json.
 *
 * run_root contract (identical to donor):
 *   spec.json              (in)   canonical worker spec
 *   execution_journal.json (out)  dispatch lifecycle journal
 *   worker_child.json      (out)  worker-local identity (supplemental)
 *   result.json            (out)  canonical worker result
 *   worker_journal.jsonl   (out)  per-op evidence log
 *   worker_stdout.log      (out)  diagnostics only — never canonical state
 *   worker_stderr.log      (out)  diagnostics only — never canonical state
 */

import fs from "node:fs";
import path from "node:path";
import { digest, pathWithin, workerExecutionId } from "./canonical.js";
import { IntegrityError } from "./errors.js";

export const WORKER_SPEC_SCHEMA = "pair.os.executor-expansion.worker-spec.v1";
export const WORKER_JOURNAL_SCHEMA = "pair.os.executor-expansion.worker-journal.v1";
export const WORKER_RESULT_SCHEMA = "pair.os.executor-expansion.worker-result.v1";
export const AUTOMATON_HARNESS_WORKER_KIND = "automaton_harness";

export interface WorkerOp {
  op: string;
  idempotency_class: string;
  risk_class: string;
  [key: string]: unknown;
}

export interface WorkerSpec {
  schema: string;
  worker_kind: string;
  worker_execution_id: string;
  execution_id: string;
  governed_task_id: string;
  mission_id: string;
  task_id: string;
  correlation_id: string;
  workspace_root: string;
  run_root: string;
  allowed_paths: string[];
  limits: { max_ops: number; timeout_seconds: number };
  policy: {
    workspace_root: string;
    allowed_paths: string[];
    allowed_ops: string[];
    denied_ops: string[];
  };
  ops: WorkerOp[];
  [key: string]: unknown;
}

/** Op contract for the automaton_harness worker kind. */
const IDEMPOTENCY_ORDER = ["READ_ONLY", "IDEMPOTENT_WRITE", "WRITE", "DESTRUCTIVE"];
const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

interface OpContract {
  required: string[];
  path_fields: string[];
  idempotency_floor: string;
  risk_floor: string;
  denied_by_default?: boolean;
}

export const AUTOMATON_HARNESS_OP_CONTRACTS: Record<string, OpContract> = {
  read_text_file: {
    required: ["path"],
    path_fields: ["path"],
    idempotency_floor: "READ_ONLY",
    risk_floor: "LOW",
  },
  write_text_file: {
    required: ["path", "content"],
    path_fields: ["path"],
    idempotency_floor: "WRITE",
    risk_floor: "MEDIUM",
  },
  append_text_file: {
    required: ["path", "content"],
    path_fields: ["path"],
    idempotency_floor: "WRITE",
    risk_floor: "MEDIUM",
  },
  delete_file: {
    required: ["path"],
    path_fields: ["path"],
    idempotency_floor: "DESTRUCTIVE",
    risk_floor: "HIGH",
    denied_by_default: true,
  },
  finish: {
    required: ["result"],
    path_fields: [],
    idempotency_floor: "READ_ONLY",
    risk_floor: "LOW",
  },
  // Bounded wait — exists so timeout/cancellation semantics are testable
  // deterministically; ms is capped at execution time.
  sleep_ms: {
    required: ["ms"],
    path_fields: [],
    idempotency_floor: "READ_ONLY",
    risk_floor: "LOW",
  },
};

export const AUTOMATON_HARNESS_DENIED_OPS = Object.entries(
  AUTOMATON_HARNESS_OP_CONTRACTS,
)
  .filter(([, c]) => c.denied_by_default)
  .map(([name]) => name);

const FORBIDDEN_PLACEHOLDER = /(\{\{|\}\}|\$\{)/;

export function opContractsForWorkerKind(
  workerKind: string,
): Record<string, OpContract> | null {
  if (workerKind === AUTOMATON_HARNESS_WORKER_KIND) {
    return AUTOMATON_HARNESS_OP_CONTRACTS;
  }
  return null;
}

export function specDigest(spec: WorkerSpec): string {
  return digest(spec);
}

export { workerExecutionId };

/**
 * Structural + policy validation of a worker spec. Mirrors donor
 * validate_worker_spec: required fields, declared ops only, op schema
 * required fields, floor classes, denied ops, placeholder rejection,
 * path ops must resolve inside policy.allowed_paths and workspace_root.
 */
export function validateWorkerSpec(spec: WorkerSpec): WorkerSpec {
  const fail = (code: string, detail: string): never => {
    throw new IntegrityError(code, detail);
  };

  if (spec.schema !== WORKER_SPEC_SCHEMA) {
    fail("FAIL_CLOSED_WORKER_SPEC_SCHEMA", String(spec.schema));
  }
  const contracts =
    opContractsForWorkerKind(spec.worker_kind) ??
    fail("FAIL_CLOSED_V2_WORKER_KIND", String(spec.worker_kind));
  for (const field of [
    "worker_execution_id",
    "execution_id",
    "governed_task_id",
    "mission_id",
    "task_id",
    "correlation_id",
    "workspace_root",
    "run_root",
  ]) {
    const v = spec[field];
    if (typeof v !== "string" || !v) {
      fail("FAIL_CLOSED_WORKER_SPEC_FIELD", field);
    }
  }
  if (!Array.isArray(spec.allowed_paths) || spec.allowed_paths.length === 0) {
    fail("FAIL_CLOSED_WORKER_SPEC_FIELD", "allowed_paths");
  }
  if (!Array.isArray(spec.ops) || spec.ops.length === 0) {
    fail("FAIL_CLOSED_WORKER_SPEC_EMPTY_OPS", spec.governed_task_id);
  }
  const maxOps = Number(spec.limits?.max_ops ?? 0);
  if (!Number.isInteger(maxOps) || maxOps < 1) {
    fail("FAIL_CLOSED_WORKER_SPEC_FIELD", "limits.max_ops");
  }
  if (spec.ops.length > maxOps) {
    fail("FAIL_CLOSED_WORKER_SPEC_OP_BUDGET", `${spec.ops.length}>${maxOps}`);
  }
  const timeout = Number(spec.limits?.timeout_seconds ?? 0);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    fail("FAIL_CLOSED_WORKER_SPEC_FIELD", "limits.timeout_seconds");
  }
  const policy = spec.policy;
  if (!policy || !Array.isArray(policy.allowed_ops) || policy.allowed_ops.length === 0) {
    fail("FAIL_CLOSED_WORKER_SPEC_FIELD", "policy.allowed_ops");
  }
  if (!pathWithin(policy.workspace_root, spec.workspace_root)) {
    fail("FAIL_CLOSED_WORKER_SPEC_POLICY_ROOT", policy.workspace_root);
  }
  for (const p of spec.allowed_paths) {
    if (!pathWithin(p, spec.workspace_root)) {
      fail("FAIL_CLOSED_WORKER_SPEC_ALLOWED_PATH", p);
    }
  }
  for (const p of policy.allowed_paths) {
    if (!pathWithin(p, spec.workspace_root)) {
      fail("FAIL_CLOSED_WORKER_SPEC_POLICY_PATH", p);
    }
  }

  const denied = new Set([...(policy.denied_ops ?? []), ...AUTOMATON_HARNESS_DENIED_OPS]);
  const allowed = new Set(policy.allowed_ops);

  for (const [index, op] of spec.ops.entries()) {
    const label = `ops[${index}]`;
    if (typeof op.op !== "string" || !op.op) {
      fail("FAIL_CLOSED_WORKER_SPEC_OP", label);
    }
    const contract = contracts[op.op];
    if (!contract) {
      fail("FAIL_CLOSED_WORKER_OP_NOT_ALLOWED", `${label}:${op.op}`);
    }
    if (!allowed.has(op.op)) {
      fail("FAIL_CLOSED_V2_OP_DISABLED", `${label}:${op.op}`);
    }
    if (denied.has(op.op) || contract.denied_by_default) {
      fail("FAIL_CLOSED_WORKER_OP_NOT_ALLOWED", `${label}:denied:${op.op}`);
    }
    for (const req of contract.required) {
      if (op[req] === undefined || op[req] === null || op[req] === "") {
        fail("FAIL_CLOSED_WORKER_SPEC_OP_FIELD", `${label}.${req}`);
      }
    }
    const idem = String(op.idempotency_class ?? "");
    const idemIdx = IDEMPOTENCY_ORDER.indexOf(idem);
    const floorIdx = IDEMPOTENCY_ORDER.indexOf(contract.idempotency_floor);
    if (idemIdx < 0 || idemIdx < floorIdx) {
      fail(
        "FAIL_CLOSED_WORKER_SPEC_IDEMPOTENCY_FLOOR",
        `${label}:${idem}<${contract.idempotency_floor}`,
      );
    }
    const risk = String(op.risk_class ?? "");
    const riskIdx = RISK_ORDER.indexOf(risk);
    const riskFloorIdx = RISK_ORDER.indexOf(contract.risk_floor);
    if (riskIdx < 0 || riskIdx < riskFloorIdx) {
      fail("FAIL_CLOSED_WORKER_SPEC_RISK_FLOOR", `${label}:${risk}<${contract.risk_floor}`);
    }
    for (const [k, v] of Object.entries(op)) {
      if (typeof v === "string" && FORBIDDEN_PLACEHOLDER.test(v)) {
        fail("FAIL_CLOSED_WORKER_SPEC_PLACEHOLDER", `${label}.${k}`);
      }
    }
    for (const pf of contract.path_fields) {
      const p = String(op[pf] ?? "");
      const resolved = path.resolve(spec.workspace_root, p);
      const inAllowed = spec.policy.allowed_paths.some((ap) =>
        pathWithin(resolved, ap),
      );
      if (!inAllowed) {
        fail("FAIL_CLOSED_WORKER_SPEC_PATH_SCOPE", `${label}.${pf}:${p}`);
      }
    }
  }
  const lastOp = spec.ops[spec.ops.length - 1];
  if (lastOp.op !== "finish") {
    fail("FAIL_CLOSED_WORKER_SPEC_NO_FINISH", spec.worker_execution_id);
  }
  // Ops the harness executes only while live (not replayable evidence).
  return spec;
}

/** Directory layout for a PAIR_WORKER_FILE run root. */
export function workerFilePaths(runRoot: string): {
  spec: string;
  executionJournal: string;
  workerChild: string;
  result: string;
  workerJournal: string;
  workerStdout: string;
  workerStderr: string;
} {
  return {
    spec: path.join(runRoot, "spec.json"),
    executionJournal: path.join(runRoot, "execution_journal.json"),
    workerChild: path.join(runRoot, "worker_child.json"),
    result: path.join(runRoot, "result.json"),
    workerJournal: path.join(runRoot, "worker_journal.jsonl"),
    workerStdout: path.join(runRoot, "worker_stdout.log"),
    workerStderr: path.join(runRoot, "worker_stderr.log"),
  };
}

export interface ExecutionJournal {
  schema: string;
  worker_execution_id: string;
  governed_task_id: string;
  execution_id: string;
  state: string;
  spec_digest: string;
  events: Array<{ at: string; event: string; detail?: string }>;
  [key: string]: unknown;
}

export function readExecutionJournal(runRoot: string): ExecutionJournal | null {
  const raw = readJsonSafe(workerFilePaths(runRoot).executionJournal);
  return raw as ExecutionJournal | null;
}

export interface WorkerResult {
  schema: string;
  worker_execution_id: string;
  execution_id: string;
  governed_task_id: string;
  mission_id: string;
  task_id: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";
  output: string;
  artifacts: Array<{ path: string; sha256: string; byte_size: number }>;
  error?: { class: string; detail: string } | null;
  completed_at: string;
  [key: string]: unknown;
}

export function readWorkerResult(runRoot: string): WorkerResult | null {
  const raw = readJsonSafe(workerFilePaths(runRoot).result);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as WorkerResult;
  if (r.schema !== WORKER_RESULT_SCHEMA) {
    return null;
  }
  return r;
}

export function readWorkerJournal(runRoot: string): Array<Record<string, unknown>> {
  const p = workerFilePaths(runRoot).workerJournal;
  if (!fs.existsSync(p)) {
    return [];
  }
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
