/**
 * env-config — canonical runtime configuration parsing (Phase A / Objective A).
 *
 * One parsing/validation seam for environment-driven runtime numbers instead
 * of scattered `Number(process.env.X)` logic. Every value must be explicitly
 * parsed, finite, positive, and bounded — a malformed value can never
 * silently disable timeout governance (NaN, Infinity, 0, negative, or an
 * absurd magnitude all fail closed at startup rather than degrade to
 * unbounded behavior).
 */

import { IntegrityError } from "./errors.js";

export interface PositiveIntBounds {
  /** Inclusive minimum. */
  min: number;
  /** Inclusive maximum — a defensive ceiling so typos cannot disable governance. */
  max: number;
  /** Human unit for diagnostics ("ms" | "s"). */
  unit: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Read a positive-integer env var with a documented default and bounds.
 * Policy = FAIL CLOSED: malformed input (`abc`, `0`, `-1`, `Infinity`,
 * out-of-range) raises FAIL_CLOSED_CONFIG_INVALID — configuration ambiguity
 * must be explicit, never silently coerced.
 */
export function readPositiveIntEnv(
  name: string,
  defaultValue: number,
  bounds: PositiveIntBounds,
  env: EnvLike = process.env as EnvLike,
): number {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") {
    if (!Number.isSafeInteger(defaultValue) || defaultValue < bounds.min || defaultValue > bounds.max) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONFIG_INVALID",
        `${name} default ${defaultValue} outside documented bounds ${bounds.min}..${bounds.max}${bounds.unit}`,
      );
    }
    return defaultValue;
  }
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || !/^[-+]?\d+$/.test(trimmed)) {
    throw new IntegrityError(
      "FAIL_CLOSED_CONFIG_INVALID",
      `${name} must be a positive integer ${bounds.unit} in ${bounds.min}..${bounds.max}; got ${JSON.stringify(trimmed).slice(0, 80)}`,
    );
  }
  if (n < bounds.min || n > bounds.max) {
    throw new IntegrityError(
      "FAIL_CLOSED_CONFIG_INVALID",
      `${name}=${n}${bounds.unit} outside bounds ${bounds.min}..${bounds.max}${bounds.unit}`,
    );
  }
  return n;
}

/* --------------------------- documented knobs --------------------------- */

/** Model/provider liveness probe budget. Unit: milliseconds. Bounds 0.5s–120s. */
export const MODEL_PROBE_TIMEOUT = {
  name: "PAIR_MODEL_PROBE_TIMEOUT_MS",
  defaultValue: 8_000,
  bounds: { min: 500, max: 120_000, unit: "ms" },
} as const;

/** LLM planner request budget. Unit: milliseconds. Bounds 2s–900s. */
export const LLM_PLANNER_TIMEOUT = {
  name: "PAIR_LLM_PLANNER_TIMEOUT_MS",
  defaultValue: 20_000,
  bounds: { min: 2_000, max: 900_000, unit: "ms" },
} as const;

/** Governed task execution budget. Unit: seconds. Bounds 5s–7200s. */
export const TASK_TIMEOUT = {
  name: "PAIR_TASK_TIMEOUT_S",
  defaultValue: 120,
  bounds: { min: 5, max: 7_200, unit: "s" },
} as const;

export function modelProbeTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(MODEL_PROBE_TIMEOUT.name, MODEL_PROBE_TIMEOUT.defaultValue, MODEL_PROBE_TIMEOUT.bounds, env);
}

export function llmPlannerTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(LLM_PLANNER_TIMEOUT.name, LLM_PLANNER_TIMEOUT.defaultValue, LLM_PLANNER_TIMEOUT.bounds, env);
}

export function taskTimeoutSeconds(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(TASK_TIMEOUT.name, TASK_TIMEOUT.defaultValue, TASK_TIMEOUT.bounds, env);
}
