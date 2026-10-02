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

/** Model-catalog enumeration (GET /models discovery) budget — a distinct
 *  operation from tier probing, so it carries its own named knob rather
 *  than sharing the probe budget (Phase E §14). Unit: milliseconds.
 *  Bounds 0.5s–120s. */
export const MODEL_DISCOVERY_TIMEOUT = {
  name: "PAIR_MODEL_DISCOVERY_TIMEOUT_MS",
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

/** Plan preview (pinned plan) expiry. Unit: seconds. Bounds 30s–24h. */
export const PLAN_PREVIEW_TTL = {
  name: "PAIR_PLAN_PREVIEW_TTL_S",
  defaultValue: 1_800,
  bounds: { min: 30, max: 86_400, unit: "s" },
} as const;

/**
 * Devin remote-session blocked grace — the window a `blocked` remote status
 * may persist before it escalates to REMOTE_INPUT_REQUIRED / FAILED. This is
 * a SEPARATE clock from the task execution budget: `blocked` is also emitted
 * transiently at turn end, so the grace window must never masquerade as the
 * total task timeout. Unit: milliseconds. Bounds 5s–1800s.
 */
export const DEVIN_BLOCKED_GRACE = {
  name: "PAIR_DEVIN_BLOCKED_GRACE_MS",
  defaultValue: 120_000,
  bounds: { min: 5_000, max: 1_800_000, unit: "ms" },
} as const;

/**
 * Devin per-execution fallback budget — COMPATIBILITY OVERRIDE ONLY.
 * The canonical governed execution budget is `task.timeout` (explicit
 * metadata.timeout → PAIR_TASK_TIMEOUT_S), persisted per execution at
 * dispatch. This env value is used solely when a dispatched task carries no
 * explicit timeout — it must never silently override the canonical budget.
 * Unit: milliseconds. Bounds 5s–7200s.
 */
export const DEVIN_TASK_TIMEOUT = {
  name: "PAIR_DEVIN_TASK_TIMEOUT_MS",
  defaultValue: 15 * 60_000,
  bounds: { min: 5_000, max: 7_200_000, unit: "ms" },
} as const;

export function modelProbeTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(MODEL_PROBE_TIMEOUT.name, MODEL_PROBE_TIMEOUT.defaultValue, MODEL_PROBE_TIMEOUT.bounds, env);
}

export function modelDiscoveryTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(MODEL_DISCOVERY_TIMEOUT.name, MODEL_DISCOVERY_TIMEOUT.defaultValue, MODEL_DISCOVERY_TIMEOUT.bounds, env);
}

export function llmPlannerTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(LLM_PLANNER_TIMEOUT.name, LLM_PLANNER_TIMEOUT.defaultValue, LLM_PLANNER_TIMEOUT.bounds, env);
}

export function taskTimeoutSeconds(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(TASK_TIMEOUT.name, TASK_TIMEOUT.defaultValue, TASK_TIMEOUT.bounds, env);
}

export function planPreviewTtlSeconds(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(PLAN_PREVIEW_TTL.name, PLAN_PREVIEW_TTL.defaultValue, PLAN_PREVIEW_TTL.bounds, env);
}

export function devinBlockedGraceMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(DEVIN_BLOCKED_GRACE.name, DEVIN_BLOCKED_GRACE.defaultValue, DEVIN_BLOCKED_GRACE.bounds, env);
}

export function devinTaskTimeoutMs(env: EnvLike = process.env as EnvLike): number {
  return readPositiveIntEnv(DEVIN_TASK_TIMEOUT.name, DEVIN_TASK_TIMEOUT.defaultValue, DEVIN_TASK_TIMEOUT.bounds, env);
}

/** R4 §3 — one canonical ceiling for governed Telegram delivery attempts
 *  (definite-failure retries). Bounded [1..10], default 3. */
export const TG_DELIVERY_MAX_ATTEMPTS = {
  name: "PAIR_TG_DELIVERY_MAX_ATTEMPTS",
  defaultValue: 3,
  bounds: { min: 1, max: 10, unit: " attempts" },
} as const;

export function telegramDeliveryMaxAttempts(
  env: EnvLike = process.env as EnvLike,
): number {
  return readPositiveIntEnv(
    TG_DELIVERY_MAX_ATTEMPTS.name,
    TG_DELIVERY_MAX_ATTEMPTS.defaultValue,
    TG_DELIVERY_MAX_ATTEMPTS.bounds,
    env,
  );
}

/** R6 §3 — canonical stale lease for a durable SENDING payload: a
 *  SENDING slot is only "stale" once now - attempt_started_at exceeds
 *  this. Fresh SENDING is never reconciled. */
export const TG_DELIVERY_STALE_AFTER_MS = {
  name: "PAIR_TG_DELIVERY_STALE_AFTER_MS",
  defaultValue: 60_000,
  bounds: { min: 5_000, max: 600_000, unit: "ms" },
} as const;

export function telegramDeliveryStaleAfterMs(
  env: EnvLike = process.env as EnvLike,
): number {
  return readPositiveIntEnv(
    TG_DELIVERY_STALE_AFTER_MS.name,
    TG_DELIVERY_STALE_AFTER_MS.defaultValue,
    TG_DELIVERY_STALE_AFTER_MS.bounds,
    env,
  );
}

/** R6 §4 — canonical bounded timeout for governed Telegram transport
 *  calls (sendMessage/sendPhoto/sendDocument). A timeout after dispatch
 *  began is UNKNOWN acceptance, never definite failure. */
export const TG_DELIVERY_TRANSPORT_TIMEOUT_MS = {
  name: "PAIR_TG_DELIVERY_TRANSPORT_TIMEOUT_MS",
  defaultValue: 25_000,
  bounds: { min: 1_000, max: 300_000, unit: "ms" },
} as const;

export function telegramDeliveryTransportTimeoutMs(
  env: EnvLike = process.env as EnvLike,
): number {
  return readPositiveIntEnv(
    TG_DELIVERY_TRANSPORT_TIMEOUT_MS.name,
    TG_DELIVERY_TRANSPORT_TIMEOUT_MS.defaultValue,
    TG_DELIVERY_TRANSPORT_TIMEOUT_MS.bounds,
    env,
  );
}

/** R6 §4 — TRANSPORT_TIMEOUT_MS must be strictly < STALE_AFTER_MS:
 *  otherwise a send could still be legitimately in-flight when the
 *  reconciler declares it stale. Fail closed at startup. */
export function assertTelegramDeliveryTiming(args: {
  staleAfterMs: number;
  transportTimeoutMs: number;
}): void {
  if (!(args.transportTimeoutMs < args.staleAfterMs)) {
    throw new IntegrityError(
      "FAIL_CLOSED_CONFIG_INVALID",
      `PAIR_TG_DELIVERY_TRANSPORT_TIMEOUT_MS (${args.transportTimeoutMs}) must be < PAIR_TG_DELIVERY_STALE_AFTER_MS (${args.staleAfterMs})`,
    );
  }
}
