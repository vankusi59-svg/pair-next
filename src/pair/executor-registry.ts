/**
 * ExecutorRegistry — canonical executor descriptors over PairEvidenceStore.
 *
 * Port of donor executor_registry.py (a557df2): normalizes executor records
 * into the frozen descriptor contract, enforces fail-closed identity
 * compatibility on re-registration, and recomputes volatile fields
 * (health / availability / active executions) at describe() time.
 *
 * P3 scope: only PAIR_NATIVE is registered. The frozen CANONICAL_IDENTITIES
 * table already reserves the donor's future executor identities so DSH /
 * CODEX / DEVIN can be added later without changing this architecture.
 */

import { digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairControlPlane } from "./service.js";

export const DESCRIPTOR_SCHEMA = "pair.os.vnext.executor-descriptor.v1";
export const DESCRIPTOR_VERSION = 1;

export const TRANSPORT_NATIVE_CLI = "NATIVE_CLI";
export const TRANSPORT_ACP_STDIO = "ACP_STDIO";
export const TRANSPORT_IN_PROCESS = "IN_PROCESS";
export const TRANSPORT_SUBPROCESS_WORKER = "SUBPROCESS_WORKER";
/** vNext: the Automaton LocalWorkerPool in-process harness transport. */
export const TRANSPORT_AUTOMATON_WORKER_POOL = "AUTOMATON_LOCAL_WORKER_POOL";
/** P9: remote REST API executor transport (DEVIN). */
export const TRANSPORT_REMOTE_API = "REMOTE_API";
export const TRANSPORT_UNKNOWN = "UNKNOWN";

/** Transports that may serve governed traffic (donor-qualified set + vNext pool). */
export const QUALIFIED_TRANSPORTS = new Set([
  TRANSPORT_NATIVE_CLI,
  TRANSPORT_ACP_STDIO,
  TRANSPORT_IN_PROCESS,
  TRANSPORT_SUBPROCESS_WORKER,
  TRANSPORT_AUTOMATON_WORKER_POOL,
  TRANSPORT_REMOTE_API,
]);

/**
 * Frozen canonical executor identities. PAIR_NATIVE is the vNext executor;
 * the donor's V0.20/V0.22 identities are reserved verbatim so future
 * executors plug into this registry without an architecture change.
 */
export const CANONICAL_IDENTITIES: Record<
  string,
  { logical_provider: string; adapter_id: string; transport_type: string; protocol_name: string; protocol_version: string | number }
> = {
  PAIR_NATIVE: {
    logical_provider: "PAIR_LOCAL",
    adapter_id: "pair_native_local_worker",
    transport_type: TRANSPORT_AUTOMATON_WORKER_POOL,
    protocol_name: "PAIR_WORKER_FILE",
    protocol_version: "1",
  },
  CODEX: {
    logical_provider: "CODEX",
    adapter_id: "codex_cli",
    transport_type: TRANSPORT_NATIVE_CLI,
    protocol_name: "CODEX_CLI_JSONL",
    protocol_version: "1",
  },
  CODEX_ACP: {
    logical_provider: "CODEX",
    adapter_id: "codex_acp",
    transport_type: TRANSPORT_ACP_STDIO,
    protocol_name: "ACP",
    protocol_version: 1,
  },
  LOCAL_COMPUTER: {
    logical_provider: "PAIR_LOCAL",
    adapter_id: "local_computer_uia",
    transport_type: TRANSPORT_SUBPROCESS_WORKER,
    protocol_name: "PAIR_WORKER_FILE",
    protocol_version: "1",
  },
  BROWSER: {
    logical_provider: "PAIR_LOCAL",
    adapter_id: "browser_playwright",
    transport_type: TRANSPORT_SUBPROCESS_WORKER,
    protocol_name: "PAIR_WORKER_FILE",
    protocol_version: "1",
  },
  DEEPSEEK_HARNESS: {
    logical_provider: "DEEPSEEK",
    adapter_id: "deepseek_harness_acp",
    transport_type: TRANSPORT_ACP_STDIO,
    protocol_name: "ACP",
    protocol_version: 1,
  },
  DEVIN: {
    logical_provider: "DEVIN",
    adapter_id: "devin_api",
    transport_type: TRANSPORT_REMOTE_API,
    protocol_name: "DEVIN_REST_API",
    protocol_version: "v3",
  },
};

/** PR #121 — the ONLY executor identities an autonomous Objective pass
 *  (driver-attributed work) may ever dispatch through. Frozen at the
 *  identity layer: dashboard executor toggles, adapter composition and
 *  route edits can never add an id to this set. CODEX bills through its
 *  ChatGPT subscription session; PAIR_NATIVE through UNMETERED local
 *  execution. DEVIN / DEEPSEEK_HARNESS are explicitly excluded even when
 *  ENABLED for manual governed work. */
export const AUTONOMOUS_EXECUTOR_IDS = ["CODEX", "PAIR_NATIVE"] as const;
export type AutonomousExecutorId = (typeof AUTONOMOUS_EXECUTOR_IDS)[number];

const IDENTITY_FIELDS = ["logical_provider", "adapter_id", "transport_type"] as const;

const VOLATILE_FIELDS = new Set([
  "health_state",
  "availability_state",
  "auth_state",
  "qualification_state",
  "active_executions",
  "quota_state",
  "rate_limit_state",
  "runtime_version",
]);

// Canonical execution-terminal set — mirrors MissionRuntime.TERMINAL_EXECUTION.
const EXECUTION_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

function sortedStrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter(Boolean))].sort();
}

export class ExecutorRegistry {
  constructor(private readonly service: PairControlPlane) {}

  private get store() {
    return this.service.store;
  }

  private activeExecutions(executorId: string): number {
    return this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.executor_id === executorId &&
          !EXECUTION_TERMINAL.has(String(e.execution_state)) &&
          // Phase D §5 / P0-F1 — terminal_outcome is durably settled.
          !e.terminal_outcome,
      ).length;
  }

  static availabilityState(record: Record<string, unknown>): string {
    if (record.status === "DISABLED" || record.health_state === "DISABLED") return "DISABLED";
    if (record.health_state === "READY") return "AVAILABLE";
    return "UNKNOWN";
  }

  static authState(metadata: Record<string, unknown>): string {
    if (metadata.auth_state) return String(metadata.auth_state);
    const mode = String(metadata.authentication_mode ?? "").toUpperCase();
    if (["CHATGPT_SESSION", "CLI_SESSION", "AUTHENTICATED"].includes(mode)) return "AUTHENTICATED";
    if (["AUTH_REQUIRED", "UNAUTHENTICATED"].includes(mode)) return "AUTH_REQUIRED";
    return "UNKNOWN";
  }

  /** Derive the canonical descriptor from an executor record. */
  normalizeDescriptor(record: Record<string, unknown>): Record<string, unknown> {
    const executorId = String(record.executor_id ?? "");
    if (!executorId) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_DESCRIPTOR_INCOMPLETE", "executor_id");
    }
    const metadata = { ...((record.metadata as Record<string, unknown>) ?? {}) };
    const canonical = CANONICAL_IDENTITIES[executorId] ?? {};
    const descriptor: Record<string, unknown> = {
      schema: DESCRIPTOR_SCHEMA,
      descriptor_version: DESCRIPTOR_VERSION,
      executor_id: executorId,
      logical_provider: metadata.logical_provider ?? canonical.logical_provider ?? executorId,
      adapter_id: metadata.adapter_id ?? canonical.adapter_id ?? executorId,
      executor_type: record.executor_type ?? "UNKNOWN",
      transport_type: metadata.transport_type ?? canonical.transport_type ?? TRANSPORT_IN_PROCESS,
      transport_version: metadata.transport_version ?? null,
      protocol_name: metadata.protocol_name ?? canonical.protocol_name ?? "PAIR_INTERNAL",
      protocol_version: metadata.protocol_version ?? canonical.protocol_version ?? null,
      capabilities: sortedStrList(record.capabilities),
      permission_modes: sortedStrList(metadata.permission_modes ?? ["READ", "WRITE"]),
      workspace_modes: sortedStrList(metadata.workspace_modes ?? ["EXPLICIT_WORKSPACE"]),
      health_state: record.health_state ?? "UNKNOWN",
      availability_state: ExecutorRegistry.availabilityState(record),
      auth_state: ExecutorRegistry.authState(metadata),
      qualification_state: String(metadata.qualification_state ?? "UNQUALIFIED"),
      supports_resume: Boolean(metadata.supports_resume),
      supports_cancel: Boolean(metadata.supports_cancel),
      supports_background_tasks: Boolean(metadata.supports_background_tasks),
      max_concurrency: Math.max(1, Number(metadata.max_concurrency ?? 1) || 1),
      active_executions: this.activeExecutions(executorId),
      quota_state: String(metadata.quota_state ?? "UNKNOWN"),
      rate_limit_state: String(metadata.rate_limit_state ?? "UNKNOWN"),
      routing_priority: Number(metadata.routing_priority ?? 100) || 100,
      adapter_version: metadata.adapter_version ?? null,
      runtime_version: metadata.runtime_version ?? metadata.runtime_identity ?? null,
      metadata,
    };
    descriptor.descriptor_digest = ExecutorRegistry.descriptorDigest(descriptor);
    return descriptor;
  }

  /** Deterministic digest over the stable identity/capability surface. */
  static descriptorDigest(descriptor: Record<string, unknown>): string {
    const stable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(descriptor)) {
      if (k !== "descriptor_digest" && !VOLATILE_FIELDS.has(k)) stable[k] = v;
    }
    return digest(stable);
  }

  /** Fail closed when re-registering a contradictory identity. */
  assertIdentityCompatible(record: Record<string, unknown>, existing: Record<string, unknown> | null): void {
    const executorId = String(record.executor_id ?? "");
    const metadata = { ...((record.metadata as Record<string, unknown>) ?? {}) };
    const declared: Record<string, unknown> = {
      logical_provider: metadata.logical_provider,
      adapter_id: metadata.adapter_id,
      transport_type: metadata.transport_type,
    };
    const canonical = CANONICAL_IDENTITIES[executorId];
    if (canonical) {
      for (const field of IDENTITY_FIELDS) {
        const value = declared[field];
        if (value != null && String(value) !== String(canonical[field])) {
          throw new IntegrityError(
            "FAIL_CLOSED_EXECUTOR_IDENTITY_CONFLICT",
            `${executorId}:${field} declared=${value} canonical=${canonical[field]}`,
          );
        }
      }
    }
    if (existing) {
      const effective = this.normalizeDescriptor(existing);
      for (const field of IDENTITY_FIELDS) {
        const value = declared[field];
        if (value == null) continue;
        const prior = effective[field];
        if (prior != null && String(prior) !== String(value)) {
          throw new IntegrityError(
            "FAIL_CLOSED_EXECUTOR_IDENTITY_CONFLICT",
            `${executorId}:${field} existing=${prior} declared=${value}`,
          );
        }
      }
    }
  }

  /** Validate + persist an executor record with its canonical descriptor. */
  register(record: Record<string, unknown>, actor = "PAIR_EXECUTOR_REGISTRY"): Record<string, unknown> {
    const executorId = String(record.executor_id ?? "");
    let existing: Record<string, unknown> | null = null;
    try {
      existing = this.store.get("executor", executorId);
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
    this.assertIdentityCompatible(record, existing);
    const payload = { ...record };
    payload.descriptor = this.normalizeDescriptor(payload);
    const saved = this.service.registerExecutor(payload, actor);
    this.store.event({
      entity_type: "executor",
      entity_id: executorId,
      event_type: existing ? "EXECUTOR_DESCRIPTOR_UPDATED" : "EXECUTOR_DESCRIPTOR_REGISTERED",
      new_state: String(saved.health_state ?? "UNKNOWN"),
      actor,
      metadata: {
        executor_id: executorId,
        descriptor_digest: (saved.descriptor as Record<string, unknown>).descriptor_digest,
        transport_type: (saved.descriptor as Record<string, unknown>).transport_type,
      },
    });
    return saved;
  }

  describe(executorId: string): Record<string, unknown> {
    return this.normalizeDescriptor(this.store.get("executor", executorId));
  }

  /**
   * Executor ON/OFF — the operator intent seam (Executor Management on
   * the Mission Control dashboard). Flips the durable `status` field the
   * CapabilityRouter already gates on (`EXECUTOR_DISABLED` is gate #1),
   * so OFF prevents every NEW dispatch — fresh routes, retries, and
   * reroutes — while already-proven executions stay history and keep
   * settling. ON flips status only: capability/health/permission/route
   * gates still apply on every dispatch. Audited via the canonical
   * event journal; concurrent flips are OCC-safe (a version-conflicted
   * write retries the whole transaction, never a lost update).
   */
  setExecutorEnabled(
    executorId: string,
    enabled: boolean,
    actor: string,
  ): Record<string, unknown> {
    const next = enabled ? "ENABLED" : "DISABLED";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return this.store.immediate(() => {
          const existing = this.store.get("executor", executorId);
          const current = String(existing.status ?? "ENABLED");
          if (current === next) return existing; // idempotent — no event
          const saved = this.store.put(
            "executor",
            executorId,
            { ...existing, status: next },
            Number(existing.version),
          );
          this.store.event({
            entity_type: "executor",
            entity_id: executorId,
            event_type: enabled ? "EXECUTOR_ENABLED" : "EXECUTOR_DISABLED",
            old_state: current,
            new_state: next,
            actor,
            metadata: { executor_id: executorId },
          });
          return saved;
        });
      } catch (error) {
        // OCC retry: a racing write (registration reconcile, another
        // toggle) bumps the row between read and CAS — re-read inside a
        // fresh transaction and retry; persistent conflict fails closed.
        if (
          (error as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw new IntegrityError("FAIL_CLOSED_VERSION_CONFLICT", executorId);
  }

  listDescriptors(): Array<Record<string, unknown>> {
    return this.service.listExecutors().map((r) => this.describe(String(r.executor_id)));
  }
}
