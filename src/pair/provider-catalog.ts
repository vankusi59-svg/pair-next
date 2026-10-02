/**
 * provider-catalog — canonical provider catalog (P6).
 *
 * Port of donor provider_catalog.py semantics (a557df2): deterministic
 * provider identity, DISCOVERED → PROBED → QUALIFIED lifecycle, snapshots,
 * access/protocol observations, qualification and sync receipts, identity
 * conflicts failing closed. Discovery never qualifies.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { sanitizeUntrustedRemote } from "./sanitizer.js";
import type { PairEvidenceStore } from "./store.js";

/** Free-text diagnostics from external providers may echo credential
 *  material — pass through the canonical sanitizer before persistence. */
export function sanitizeDiagnostic(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  return String(sanitizeUntrustedRemote(String(text).slice(0, 200)).value);
}

export const PROVIDER_LIFECYCLE_ORDER = [
  "DISCOVERED",
  // Enumeration-only bootstrap state: the provider may be scanned for model
  // claims, but carries NO runtime routing authority (not in OK_STATES).
  // Runtime authority is reachable only through canonical qualification.
  "DISCOVERY_ELIGIBLE",
  "PROBED",
  "ACCESS_VALIDATED",
  "QUALIFIED",
  "MODEL_DISCOVERY_ELIGIBLE",
] as const;

export const PROVIDER_OK_STATES = new Set(["QUALIFIED", "MODEL_DISCOVERY_ELIGIBLE"]);

/** Lifecycle states a provider may be enumerated for model claims under —
 *  canonical MODEL_DISCOVERY_ELIGIBLE (qualified) plus the enumeration-only
 *  bootstrap state. Discovery eligibility never implies routability. */
export const PROVIDER_DISCOVERY_SCAN_STATES = new Set([
  "MODEL_DISCOVERY_ELIGIBLE",
  "DISCOVERY_ELIGIBLE",
]);

/** Provider absence reconciliation (Phase E §5): consecutive COMPLETE
 *  discovery runs in which every authoritative source misses the provider.
 *  streak >= 1 → STALE condition; >= threshold → REMOVED (non-routable,
 *  history preserved). */
export const PROVIDER_REMOVED_ABSENCE_THRESHOLD = 3;

const IDENTITY_FIELDS = [
  "provider_id",
  "provider_type",
  "protocol_family",
  "configured_endpoint_identity",
  "credential_reference_name",
] as const;

export const SOURCE_PRECEDENCE: Record<string, number> = {
  OPERATOR_MANIFEST: 90,
  PAIR_PROVIDER_REGISTRY: 80,
  CONFIGURED_ENDPOINT: 70,
  DSH_PROVIDER_CATALOG: 60,
  CREDENTIAL_REFERENCE: 50,
  ROUTING_SUBSTRATE: 40,
  INSTALLED_ADAPTER: 30,
};

const SECRET_KEY_RE =
  /(api[_-]?key|apikey|secret|token|password|private[_-]?key|authorization|bearer)/i;
const ALLOWED_CREDENTIAL_KEYS = new Set([
  "credential_reference_name",
  "credential_envs",
  "credential_env_names",
  "apikeyenv",
]);

export function assertSecretSafe(payload: unknown, path = ""): void {
  if (Array.isArray(payload)) {
    for (const item of payload) assertSecretSafe(item, `${path}[]`);
    return;
  }
  if (payload === null || typeof payload !== "object") return;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const loc = `${path}${key}`;
    if (SECRET_KEY_RE.test(key) && !ALLOWED_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      if (value !== null && value !== undefined && value !== "") {
        throw new IntegrityError(
          "FAIL_CLOSED_SECRET_VALUE_IN_PROVIDER_PAYLOAD",
          loc,
        );
      }
      continue;
    }
    assertSecretSafe(value, `${loc}.`);
  }
}

export function normalizeEndpointIdentity(reference: unknown): string | null {
  if (reference === null || reference === undefined || reference === "") return null;
  const ref = String(reference).trim();
  if (ref.startsWith("env:")) return ref;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return ref;
  }
  const scheme = (url.protocol.replace(/:$/, "") || "https").toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port && !["80", "443"].includes(url.port) ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${scheme}://${host}${port}${path}`;
}

export function providerEntryId(providerId: string): string {
  return `PRV_${digest({ provider_id: providerId }).slice(0, 24)}`;
}

export function providerIdentityDigest(entry: Record<string, unknown>): string {
  const mat: Record<string, unknown> = {};
  for (const k of IDENTITY_FIELDS) mat[k] = entry[k] ?? null;
  return digest(mat);
}

/** Deterministic canonical id for a provider candidate claim. */
export function resolveCanonicalId(candidate: Record<string, unknown>): {
  canonicalId: string;
  resolvedVia: string;
} {
  if (candidate.canonical_hint) {
    return { canonicalId: String(candidate.canonical_hint), resolvedVia: "CANONICAL_HINT" };
  }
  const native = String(candidate.provider_native_id ?? "");
  if (native.toUpperCase().startsWith("DSH:")) {
    const inner = native.split(":", 2)[1];
    return { canonicalId: inner, resolvedVia: "DSH_PROVIDER_ID_LINKAGE" };
  }
  return { canonicalId: native, resolvedVia: "NATIVE_ID" };
}

interface PutOpts {
  actor: string;
  eventType?: string;
}

export class ProviderCatalog {
  constructor(private readonly store: PairEvidenceStore) {}

  private put(eid: string, body: Record<string, unknown>, opts: PutOpts) {
    assertSecretSafe(body);
    const old = this.store.tryGet("provider", eid);
    const version = old ? Number(old.version) : 0;
    const saved = this.store.put("provider", eid, body, version);
    if (opts.eventType) {
      this.store.event({
        entity_type: "provider",
        entity_id: eid,
        event_type: opts.eventType,
        old_state: old ? String(old.lifecycle_state ?? null) : null,
        new_state: String(saved.lifecycle_state ?? null),
        actor: opts.actor,
      });
    }
    return saved;
  }

  getProvider(providerId: string): Record<string, unknown> | null {
    return this.store.tryGet("provider", providerEntryId(providerId));
  }

  listProviders(): Array<Record<string, unknown>> {
    return this.store
      .list("provider")
      .sort((a, b) => String(a.provider_id).localeCompare(String(b.provider_id)));
  }

  private baseEntry(providerId: string): Record<string, unknown> {
    return {
      provider_id: providerId,
      entry_id: providerEntryId(providerId),
      display_name: providerId,
      provider_type: null,
      protocol_family: null,
      provider_family: null,
      configured_endpoint_identity: null,
      endpoint_reference: null,
      credential_reference_name: null,
      credential_envs: [],
      lifecycle_state: "DISCOVERED",
      auth_state: "UNVALIDATED",
      probe_state: "UNPROBED",
      health_state: "UNKNOWN",
      conditions: [],
      capabilities: [],
      absence_streak: 0,
      sources: [],
      evidence_refs: [],
      contradictions: [],
      first_seen_at: utcnow(),
      last_seen_at: utcnow(),
      last_probe_at: null,
      last_qualified_at: null,
      current_qualification_receipt_id: null,
      version: 0,
    };
  }

  /**
   * Fold one discovered candidate into the canonical provider entry.
   * Idempotent; conflicting identity fails closed.
   */
  upsertCandidate(
    candidate: Record<string, unknown>,
    actor = "PAIR_PROVIDER_CATALOG",
  ): { entry: Record<string, unknown>; created: boolean; semanticNoOp: boolean } {
    assertSecretSafe(candidate);
    const { canonicalId, resolvedVia } = resolveCanonicalId(candidate);
    if (!canonicalId) {
      throw new IntegrityError("FAIL_CLOSED_PROVIDER_CANDIDATE_NO_ID", JSON.stringify(candidate).slice(0, 200));
    }
    const providerId = canonicalId;
    const existing = this.getProvider(providerId);
    const sourceId = String(candidate.source_id ?? "UNKNOWN");
    const sourcePrecedence = SOURCE_PRECEDENCE[sourceId] ?? 0;
    const now = utcnow();

    if (!existing) {
      const body = this.baseEntry(providerId);
      this.applyCandidateFields(body, candidate, sourcePrecedence, resolvedVia);
      body.sources = [sourceId];
      body.identity_digest = providerIdentityDigest(body);
      const entry = this.put(body.entry_id as string, body, { actor, eventType: "PROVIDER_DISCOVERED" });
      return { entry, created: true, semanticNoOp: false };
    }

    // Conflicting identity: same canonical id but materially different facets
    // from an equal-or-higher precedence source → fail closed.
    const body: Record<string, unknown> = { ...existing };
    body.version = Number(existing.version);
    const changed = this.applyCandidateFields(body, candidate, sourcePrecedence, resolvedVia);
    const sources = new Set(body.sources as string[]);
    sources.add(sourceId);
    body.sources = [...sources].sort();
    body.last_seen_at = now;
    // Current observation resets absence bookkeeping and revives a
    // stale/removed entry as REAPPEARED (history kept). Phase E R1 §2 —
    // reappearance restores OBSERVATION only, never runtime authority:
    // a provider that lost currentness must re-run the normal
    // validateAccess → probe → qualification chain to mint new/current
    // authority. Historical rows (receipt, events) stay inspectable.
    body.absence_streak = 0;
    const conditions = new Set((body.conditions as string[]) ?? []);
    if (conditions.has("REMOVED") || conditions.has("STALE")) {
      conditions.delete("REMOVED");
      conditions.delete("STALE");
      conditions.add("REAPPEARED");
      body.lifecycle_state = "DISCOVERY_ELIGIBLE";
      body.auth_state = "AUTH_REQUIRED";
      body.probe_state = "UNPROBED";
      // Phase E R2 §6 — the historical receipt row stays inspectable but
      // is no longer CURRENT authority: clear the pointer so nothing can
      // lean on a stale current receipt behind the lifecycle demotion.
      body.current_qualification_receipt_id = null;
    }
    body.conditions = [...conditions].sort();
    body.identity_digest = providerIdentityDigest(body);
    const semanticNoOp = !changed && String(body.identity_digest) === String(existing.identity_digest);
    const entry = this.put(body.entry_id as string, body, {
      actor,
      eventType: changed ? "PROVIDER_ENTRY_UPDATED" : undefined as unknown as string,
    });
    return { entry, created: false, semanticNoOp };
  }

  private applyCandidateFields(
    body: Record<string, unknown>,
    candidate: Record<string, unknown>,
    sourcePrecedence: number,
    resolvedVia: string,
  ): boolean {
    let changed = false;
    const fieldSources = (body.provenance as Record<string, Record<string, number>> | undefined)
      ?? { field_sources: {} };
    body.provenance = fieldSources;
    const fs = fieldSources.field_sources ?? (fieldSources.field_sources = {});

    const setIf = (key: string, value: unknown, precedenceKey: string) => {
      if (value === undefined || value === null || value === "") return;
      const prior = body[key];
      const priorPrec = fs[precedenceKey] ?? -1;
      if (prior !== undefined && prior !== null && prior !== "" && prior !== value) {
        if (priorPrec > sourcePrecedence) return; // stronger source already set
        // equal-or-lower precedence disagreement on an identity facet → conflict
        if (precedenceKey === "provider_type" || precedenceKey === "protocol_family") {
          const contradictions = (body.contradictions as unknown[]) ?? [];
          contradictions.push({ field: precedenceKey, prior, candidate: value });
          body.contradictions = contradictions;
          if (priorPrec === sourcePrecedence) {
            throw new IntegrityError(
              "FAIL_CLOSED_PROVIDER_IDENTITY_CONFLICT",
              `${body.provider_id}:${precedenceKey}:${prior}!=${value}`,
            );
          }
        }
      }
      body[key] = value;
      fs[precedenceKey] = Math.max(sourcePrecedence, fs[precedenceKey] ?? 0);
      if (prior !== value) changed = true;
    };

    setIf("display_name", candidate.display_name ?? candidate.provider_id, "display_name");
    setIf("provider_type", candidate.provider_type, "provider_type");
    setIf("protocol_family", candidate.protocol_family ?? candidate.provider_type, "protocol_family");
    setIf("provider_family", candidate.provider_family, "provider_family");
    const endpoint = normalizeEndpointIdentity(
      candidate.endpoint_reference ?? candidate.base_url ?? candidate.configured_endpoint_identity,
    );
    setIf("endpoint_reference", endpoint, "endpoint_reference");
    setIf("configured_endpoint_identity", endpoint, "configured_endpoint_identity");
    const candidateEnvs = Array.isArray(candidate.credential_envs) ? (candidate.credential_envs as string[]) : [];
    setIf("credential_reference_name", candidate.credential_reference_name ?? candidateEnvs[0], "credential_reference_name");
    if (candidateEnvs.length) {
      const envs = new Set([...(body.credential_envs as string[]), ...candidateEnvs.map(String)]);
      const merged = [...envs].sort();
      if (JSON.stringify(merged) !== JSON.stringify(body.credential_envs)) changed = true;
      body.credential_envs = merged;
    }
    if (Array.isArray(candidate.capabilities)) {
      const caps = new Set([...(body.capabilities as string[]), ...candidate.capabilities.map(String)]);
      const merged = [...caps].sort();
      if (JSON.stringify(merged) !== JSON.stringify(body.capabilities)) changed = true;
      body.capabilities = merged;
    }
    if (candidate.evidence_refs) {
      const refs = new Set([...(body.evidence_refs as string[]), ...(candidate.evidence_refs as string[]).map(String)]);
      body.evidence_refs = [...refs].sort();
    }
    void resolvedVia;
    return changed;
  }

  recordAccessObservation(
    providerId: string,
    outcome: string,
    opts: { actor?: string } = {},
  ): Record<string, unknown> {
    const entry = this.mustGet(providerId);
    const body = { ...entry };
    body.version = Number(entry.version);
    body.auth_state = outcome === "AUTH_OK" || outcome === "ACCESS_OK" ? "AUTH_OK"
      : outcome === "ACCESS_DENIED" || outcome === "AUTH_FAILED" ? "AUTH_FAILED"
      : outcome;
    if (outcome === "AUTH_OK" || outcome === "ACCESS_OK") {
      body.lifecycle_state = "ACCESS_VALIDATED";
    }
    this.store.event({
      entity_type: "provider",
      entity_id: String(entry.entry_id),
      event_type: "PROVIDER_ACCESS_OBSERVED",
      new_state: outcome,
      actor: opts.actor ?? "PAIR_PROVIDER_CATALOG",
    });
    return this.put(String(entry.entry_id), body, { actor: opts.actor ?? "PAIR_PROVIDER_CATALOG" });
  }

  recordProbeObservation(
    providerId: string,
    outcome: string,
    opts: { latency_ms?: number; detail?: string; actor?: string } = {},
  ): Record<string, unknown> {
    const entry = this.mustGet(providerId);
    const body = { ...entry };
    body.version = Number(entry.version);
    body.probe_state = outcome === "PASS" ? "PROBED" : `PROBE_${outcome}`;
    body.last_probe_at = utcnow();
    if (outcome === "PASS" && body.lifecycle_state === "DISCOVERED") {
      body.lifecycle_state = "PROBED";
    }
    this.store.event({
      entity_type: "provider",
      entity_id: String(entry.entry_id),
      event_type: outcome === "PASS" ? "PROVIDER_PROBED" : "PROVIDER_PROBE_FAILED",
      new_state: outcome,
      actor: opts.actor ?? "PAIR_PROVIDER_CATALOG",
      metadata: { latency_ms: opts.latency_ms ?? null, detail: sanitizeDiagnostic(opts.detail) },
    });
    return this.put(String(entry.entry_id), body, { actor: opts.actor ?? "PAIR_PROVIDER_CATALOG" });
  }

  setLifecycle(
    providerId: string,
    lifecycle: string,
    opts: { conditions?: string[]; actor?: string } = {},
  ): Record<string, unknown> {
    const entry = this.mustGet(providerId);
    const body = { ...entry };
    body.version = Number(entry.version);
    body.lifecycle_state = lifecycle;
    if (opts.conditions) body.conditions = [...opts.conditions].sort();
    if (lifecycle === "QUALIFIED" || lifecycle === "MODEL_DISCOVERY_ELIGIBLE") {
      body.last_qualified_at = utcnow();
    }
    return this.put(String(entry.entry_id), body, { actor: opts.actor ?? "PAIR_PROVIDER_CATALOG" });
  }

  /**
   * Phase E §5 — provider absence reconciliation across sources.
   * `claimedBySource` maps each discovery source that completed a run to
   * the provider_ids it observed. A provider is absent ONLY when no
   * authoritative source claims it — absence from ONE source must not
   * revoke a provider still proven current by another. Streak >= 1 →
   * STALE condition (inspectable); streak >= PROVIDER_REMOVED_ABSENCE_
   * THRESHOLD → REMOVED (non-routable, history preserved). Re-observation
   * clears the streak/condition (handled in upsertCandidate).
   */
  reconcileProviderAbsence(
    claimedBySource: Map<string, Set<string>>,
    opts: { actor?: string; threshold?: number } = {},
  ): { stale: string[]; removed: string[]; reappeared: string[] } {
    const stale: string[] = [];
    const removed: string[] = [];
    const reappeared: string[] = [];
    const threshold = opts.threshold ?? PROVIDER_REMOVED_ABSENCE_THRESHOLD;
    if (claimedBySource.size === 0) return { stale, removed, reappeared };
    const allClaimed = new Set<string>();
    for (const ids of claimedBySource.values()) {
      for (const id of ids) allClaimed.add(id);
    }
    for (const entry of this.listProviders()) {
      const pid = String(entry.provider_id);
      const observingSources = (entry.sources as unknown[]) ?? [];
      // Only providers this discovery surface actually claims are subject
      // to reconciliation — operator/persisted entities discovered through
      // other authorities are untouched.
      const discovered = [...observingSources].some((s) =>
        claimedBySource.has(String((s as { source_id?: string })?.source_id ?? s)),
      );
      if (!discovered) continue;
      if (allClaimed.has(pid)) continue; // still observed by ≥1 source
      const body = { ...entry };
      body.version = Number(entry.version);
      const streak = Number(entry.absence_streak ?? 0) + 1;
      body.absence_streak = streak;
      const conditions = new Set(body.conditions as string[]);
      if (streak >= threshold) {
        if (!conditions.has("REMOVED")) {
          conditions.delete("STALE");
          conditions.add("REMOVED");
          removed.push(pid);
        }
      } else {
        conditions.add("STALE");
        stale.push(pid);
      }
      body.conditions = [...conditions].sort();
      this.put(String(entry.entry_id), body, {
        actor: opts.actor ?? "PAIR_PROVIDER_DISCOVERY",
        eventType: conditions.has("REMOVED")
          ? "PROVIDER_REMOVED"
          : "PROVIDER_STALE",
      });
    }
    return { stale, removed, reappeared };
  }

  /** Per-source provider snapshot — the absence-reconciliation evidence
   *  input. COMPLETE snapshots are the only authoritative "I looked and
   *  saw/didn't see" claim; FAILED snapshots never remove anything. */
  recordProviderSnapshot(
    sourceId: string,
    status: string,
    claimedProviderIds: string[],
    opts: { runId?: string; actor?: string } = {},
  ): Record<string, unknown> {
    const rec = {
      snapshot_id: newId("PSN"),
      source_id: sourceId,
      status,
      claimed_provider_ids: [...claimedProviderIds].sort(),
      run_id: opts.runId ?? null,
      recorded_at: utcnow(),
    };
    this.store.put("provider_snapshot", rec.snapshot_id, rec);
    return rec;
  }

  /** Phase E R1 §8 — whether a source has ever recorded a COMPLETE
   *  snapshot here. Distinguishes "never configured" (silently skipped)
   *  from "previously-active authoritative source disappeared". */
  hasCompletedSnapshot(sourceId: string): boolean {
    return (this.store.list("provider_snapshot") as Record<string, unknown>[]).some(
      (s) => String(s.source_id) === sourceId && String(s.status) === "COMPLETE",
    );
  }

  issueQualificationReceipt(
    providerId: string,
    opts: { policy_version: string; gates: Record<string, unknown>; actor?: string },
  ): Record<string, unknown> {
    const entry = this.mustGet(providerId);
    // Phase E R3 §5–§7 — this commit seam installs QUALIFIED authority, so
    // it validates durable canonical state itself rather than trusting the
    // caller: AUTH_OK + PROBED + no STALE/REMOVED, and a receipt never
    // mints over failing gates. DISABLED/UNQUALIFIED are deliberately NOT
    // rejected: DISABLED is operator authority preserved through
    // requalification (never routable — PROVIDER_NOT_BLOCKED blocks
    // downstream), and UNQUALIFIED is transient residue this same
    // transition canonically clears (blocking it would deadlock
    // requalification).
    const blocked =
      String(entry.auth_state) !== "AUTH_OK"
        ? `auth_state=${entry.auth_state}`
        : String(entry.probe_state) !== "PROBED"
          ? `probe_state=${entry.probe_state}`
          : ((entry.conditions as string[]) ?? []).some((c) => ["STALE", "REMOVED"].includes(c))
            ? `conditions=${JSON.stringify(entry.conditions)}`
            : null;
    if (blocked) {
      throw new IntegrityError(
        "FAIL_CLOSED_PROVIDER_QUALIFICATION_STATE",
        JSON.stringify({ provider_id: providerId, blocked_by: blocked }),
      );
    }
    const failing = Object.entries(opts.gates).filter(([, v]) => v !== "PASS");
    if (failing.length) {
      throw new IntegrityError(
        "FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES",
        JSON.stringify({ provider_id: providerId, failing_gates: failing.map(([k]) => k) }),
      );
    }
    const receipt = {
      receipt_id: newId("PQR"),
      provider_id: providerId,
      policy_version: opts.policy_version,
      material_fingerprint: providerIdentityDigest(entry),
      gates: opts.gates,
      issued_at: utcnow(),
    };
    this.store.put("provider_qualification", receipt.receipt_id, receipt);
    const body = { ...entry };
    body.version = Number(entry.version);
    body.current_qualification_receipt_id = receipt.receipt_id;
    body.lifecycle_state = "QUALIFIED";
    body.last_qualified_at = receipt.issued_at;
    // Successful canonical qualification supersedes a historical
    // UNQUALIFIED marker — provider state must not stay internally
    // contradictory. DISABLED and other operator/policy conditions are
    // preserved (they are explicit authority, not transient residue).
    body.conditions = ((entry.conditions as string[]) ?? []).filter((c) => c !== "UNQUALIFIED").sort();
    this.put(String(entry.entry_id), body, { actor: opts.actor ?? "PAIR_PROVIDER_CATALOG", eventType: "PROVIDER_QUALIFIED" });
    return receipt;
  }

  recordSyncReceipt(
    runId: string,
    results: { created: string[]; updated: string[]; unchanged: string[]; errors: Record<string, string> },
    opts: { actor?: string } = {},
  ): Record<string, unknown> {
    const receipt = {
      sync_id: newId("PSY"),
      run_id: runId,
      status: Object.keys(results.errors).length
        ? (results.created.length + results.updated.length + results.unchanged.length ? "PARTIAL" : "FAILED")
        : "COMPLETED",
      created: results.created,
      updated: results.updated,
      unchanged: results.unchanged,
      errors: results.errors,
      recorded_at: utcnow(),
    };
    this.store.put("provider_sync", receipt.sync_id, receipt);
    return receipt;
  }

  private mustGet(providerId: string): Record<string, unknown> {
    const entry = this.getProvider(providerId);
    if (!entry) throw new NotFoundError(`provider:${providerId}`);
    return entry;
  }
}
