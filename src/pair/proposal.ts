/**
 * Proposal validation seam (donor autonomy.py PairPlanValidator semantics).
 *
 * Automaton proposes WHAT (planner output). PAIR validates WHETHER the
 * resulting governed actions may execute. This module validates only —
 * it never mutates state and never dispatches.
 */

import { IntegrityError } from "./errors.js";

export interface ProposedTask {
  task_key: string;
  title: string;
  description?: string;
  task_instruction?: string;
  required_capabilities: string[];
  depends_on: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PlanProposal {
  tasks: ProposedTask[];
  metadata?: Record<string, unknown>;
}

/**
 * Validate an Automaton-side planner proposal into a dispatchable task list.
 * Fail-closed: schema defects, duplicate keys, unknown deps, cycles,
 * unresolved capability references, and placeholder values all reject.
 */
export function validatePlanProposal(
  proposal: unknown,
  knownCapabilities: Set<string>,
): ProposedTask[] {
  const fail = (code: string, detail: string): never => {
    throw new IntegrityError(code, detail);
  };
  const p = proposal as PlanProposal;
  if (!p || typeof p !== "object" || !Array.isArray(p.tasks) || p.tasks.length === 0) {
    fail("FAIL_CLOSED_PLAN_PROPOSAL_INVALID", "tasks");
  }
  const tasks = p.tasks;
  const keys = new Set<string>();
  for (const [i, t] of tasks.entries()) {
    if (!t || typeof t !== "object") {
      fail("FAIL_CLOSED_TASK_SCHEMA_INVALID", `tasks[${i}]`);
    }
    for (const field of ["task_key", "title", "required_capabilities"] as const) {
      if (t[field] === undefined || t[field] === null || t[field] === "") {
        fail("FAIL_CLOSED_TASK_SCHEMA_INVALID", `${t.task_key ?? i}:${field}`);
      }
    }
    if (keys.has(t.task_key)) {
      fail("FAIL_CLOSED_DUPLICATE_TASK_KEY", t.task_key);
    }
    keys.add(t.task_key);
    if (!Array.isArray(t.required_capabilities) || t.required_capabilities.length === 0) {
      fail("FAIL_CLOSED_TASK_CAPABILITY_REQUIRED", t.task_key);
    }
    for (const cap of t.required_capabilities) {
      if (!knownCapabilities.has(String(cap))) {
        fail("FAIL_CLOSED_TASK_CAPABILITY_UNKNOWN", `${t.task_key}:${cap}`);
      }
    }
    if (!Array.isArray(t.depends_on)) {
      fail("FAIL_CLOSED_TASK_SCHEMA_INVALID", `${t.task_key}:depends_on`);
    }
    for (const dep of t.depends_on) {
      if (dep === t.task_key) {
        fail("FAIL_CLOSED_TASK_SELF_DEPENDENCY", t.task_key);
      }
      if (!keys.has(dep) && !tasks.some((x) => x.task_key === dep)) {
        fail("FAIL_CLOSED_TASK_DEPENDENCY_UNKNOWN", `${t.task_key}:${dep}`);
      }
    }
    // Placeholder rejection — PAIR has no inter-task template substitution.
    const scan = (v: unknown, label: string): void => {
      if (typeof v === "string" && /(\{\{|\}\}|\$\{)/.test(v)) {
        fail("FAIL_CLOSED_WORKER_SPEC_PLACEHOLDER", `${t.task_key}.${label}`);
      }
      if (v && typeof v === "object") {
        for (const [k, vv] of Object.entries(v)) {
          scan(vv, `${label}.${k}`);
        }
      }
      if (Array.isArray(v)) {
        for (const [j, vv] of v.entries()) {
          scan(vv, `${label}[${j}]`);
        }
      }
    };
    scan(t.metadata ?? {}, "metadata");
  }

  // DAG check.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(tasks.map((t) => [t.task_key, t]));
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      fail("FAIL_CLOSED_TASK_DEPENDENCY_CYCLE", key);
    }
    if (visited.has(key)) {
      return;
    }
    visiting.add(key);
    for (const dep of byKey.get(key)?.depends_on ?? []) {
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const t of tasks) {
    visit(t.task_key);
  }
  return tasks;
}
