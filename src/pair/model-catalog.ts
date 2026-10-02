/**
 * model-catalog — canonical model claim store (P6).
 *
 * Port of donor model_evidence_catalog.py semantics (a557df2): canonical
 * model_entry entities (provider_family:model_id), capability_claims that
 * stay UNKNOWN until probed, idempotent claim folding (semantic_no_op /
 * reappeared), absence reconciliation (absence_streak → REMOVED, never
 * silent delete), snapshots, claim evidence, qualification receipts.
 * Additive evidence — never mutates routing.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { assertSecretSafe } from "./provider-catalog.js";
import type { PairEvidenceStore } from "./store.js";

export const REMOVED_ABSENCE_THRESHOLD = 3;
export const MODEL_TERMINAL_FOR_ROUTING = new Set(["REMOVED", "DEPRECATED", "BLOCKED"]);

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

export function canonicalModelId(providerFamily: string, modelId: string): string {
  return `ME_${digest({ provider_family: norm(providerFamily).toUpperCase(), model_id: norm(modelId) }).slice(0, 24)}`;
}

export function modelIdentityDigest(entry: Record<string, unknown>): string {
  // Phase E R1 §12 — provider ownership is part of model authority:
  // qualification material must bind it. A receipt minted for provider P1
  // + model M can never remain valid if the linkage changes to P2.
  return digest({
    model_entry_id: entry.model_entry_id,
    provider_id: entry.provider_id ?? null,
    provider_family: entry.provider_family,
    model_id: entry.model_id,
    model_alias_ids: entry.model_alias_ids ?? [],
  });
}

export function modelSemanticDigest(entry: Record<string, unknown>): string {
  return digest({
    display_name: entry.display_name ?? null,
    capability_claims: entry.capability_claims ?? {},
    context_window: entry.context_window ?? null,
    status_hint: entry.status_hint ?? null,
  });
}

export interface ModelClaim {
  provider_id: string;
  provider_family: string;
  model_id: string;
  model_native_id?: string;
  display_name?: string;
  capability_hints?: string[];
  context_window_hint?: unknown;
  status_hint?: string;
  observed_at?: string;
}

export class ModelEvidenceCatalog {
  constructor(private readonly store: PairEvidenceStore) {}

  getModel(modelEntryId: string): Record<string, unknown> | null {
    return this.store.tryGet("model_entry", modelEntryId);
  }

  getModelByIds(providerFamily: string, modelId: string): Record<string, unknown> | null {
    return this.getModel(canonicalModelId(providerFamily, modelId));
  }

  listModels(providerId?: string): Array<Record<string, unknown>> {
    let entries = this.store.list("model_entry");
    if (providerId !== undefined) {
      entries = entries.filter((e) => e.provider_id === providerId);
    }
    return entries.sort((a, b) => String(a.model_entry_id).localeCompare(String(b.model_entry_id)));
  }

  private baseEntry(modelEntryId: string): Record<string, unknown> {
    return {
      model_entry_id: modelEntryId,
      provider_id: null,
      provider_family: null,
      model_id: null,
      display_name: null,
      lifecycle_state: "DISCOVERED",
      capability_claims: {},
      context_window: null,
      rate_limit_metadata: null,
      cost_metadata: null,
      probe_receipt_ids: [],
      current_qualification_receipt_id: null,
      conditions: [],
      status_hint: "LISTED",
      model_alias_ids: [],
      contradictions: [],
      absence_streak: 0,
      provenance: { field_sources: {} },
      first_seen_at: utcnow(),
      last_seen_at: null,
      last_probe_at: null,
      last_qualified_at: null,
      stale_after: null,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
  }

  /** Fold one adapter claim into the canonical model_entry. Idempotent. */
  upsertModelClaim(
    claim: ModelClaim,
    actor = "PAIR_MODEL_CATALOG",
  ): { entry: Record<string, unknown>; created: boolean; semanticNoOp: boolean; reappeared: boolean } {
    assertSecretSafe(claim);
    const providerFamily = norm(claim.provider_family) || "UNKNOWN";
    const modelId = norm(claim.model_id);
    if (!modelId) {
      throw new IntegrityError("FAIL_CLOSED_MODEL_CLAIM_MISSING_MODEL_ID", JSON.stringify(claim).slice(0, 200));
    }
    const mid = canonicalModelId(providerFamily, modelId);
    const existing = this.getModel(mid);
    const now = utcnow();

    if (!existing) {
      const body = this.baseEntry(mid);
      body.provider_id = claim.provider_id ?? null;
      body.provider_family = providerFamily;
      body.model_id = modelId;
      body.display_name = claim.display_name ?? modelId;
      body.status_hint = claim.status_hint ?? "LISTED";
      for (const h of claim.capability_hints ?? []) {
        (body.capability_claims as Record<string, string>)[h] = "UNKNOWN";
      }
      if (claim.context_window_hint) {
        (body.capability_claims as Record<string, string>).context_window = `HINT:${claim.context_window_hint}`;
      }
      const native = norm(claim.model_native_id);
      if (native && native !== modelId) body.model_alias_ids = [native];
      body.identity_digest = modelIdentityDigest(body);
      body.semantic_digest = modelSemanticDigest(body);
      body.last_seen_at = now;
      const entry = this.put(mid, body, actor, "MODEL_DISCOVERED");
      return { entry, created: true, semanticNoOp: false, reappeared: false };
    }

    const body: Record<string, unknown> = { ...existing };
    body.version = Number(existing.version);
    let changed = false;
    for (const f of ["provider_id", "display_name"] as const) {
      if (claim[f] && !body[f]) {
        body[f] = claim[f];
        changed = true;
      }
    }
    // Phase E §8 — the provider_family+model_id identity is intentionally an
    // aliasing identity; when a second claim for the same entry names a
    // DIFFERENT provider_id, record a contradiction instead of silently
    // folding (the entry keeps its first-seen provider link — never flips).
    if (
      claim.provider_id &&
      body.provider_id &&
      String(claim.provider_id) !== String(body.provider_id)
    ) {
      const contradictions = (body.contradictions as unknown[]) ?? [];
      contradictions.push({
        field: "provider_id",
        prior: body.provider_id,
        candidate: String(claim.provider_id),
      });
      body.contradictions = contradictions;
      changed = true;
    }
    const claims = { ...(body.capability_claims as Record<string, string>) };
    for (const h of claim.capability_hints ?? []) {
      if (!(h in claims)) {
        claims[h] = "UNKNOWN";
        changed = true;
      }
    }
    body.capability_claims = claims;
    const native = norm(claim.model_native_id);
    if (native && native !== body.model_id) {
      const aliases = new Set(body.model_alias_ids as string[]);
      if (!aliases.has(native)) {
        aliases.add(native);
        body.model_alias_ids = [...aliases].sort();
        changed = true;
      }
    }
    body.identity_digest = modelIdentityDigest(body);
    body.last_seen_at = now;
    body.updated_at = now;
    let reappeared = false;
    const conditions = new Set(body.conditions as string[]);
    // Phase E R1 §3 — reappearance restores OBSERVATION only. A model that
    // reached STALE/REMOVED regains no new-work authority: lifecycle drops
    // back to DISCOVERED and it must re-run fresh probe + qualifyModel to
    // mint a new/current receipt. Historical evidence stays inspectable.
    // Phase E R2 §1-§2 — the CURRENT observation epoch resets too: probe
    // state, current receipt pointer, and the current probe_receipt_ids
    // window. Historical probe_receipt entities stay persisted and
    // inspectable but can never be consumed as current authority.
    if (conditions.has("REMOVED") || conditions.has("STALE")) {
      conditions.delete("REMOVED");
      conditions.delete("STALE");
      conditions.add("REAPPEARED");
      body.lifecycle_state = "DISCOVERED";
      body.probe_state = "UNPROBED";
      body.last_probe_at = null;
      body.current_qualification_receipt_id = null;
      body.probe_receipt_ids = [];
      reappeared = true;
      changed = true;
    }
    body.conditions = [...conditions].sort();
    body.absence_streak = 0;
    body.semantic_digest = modelSemanticDigest(body);
    const semanticNoOp = body.semantic_digest === existing.semantic_digest && !changed;
    const entry = this.put(mid, body, actor, semanticNoOp ? undefined : "MODEL_ENTRY_UPDATED");
    return { entry, created: false, semanticNoOp, reappeared };
  }

  recordModelClaimEvidence(
    adapterId: string,
    claim: ModelClaim,
    modelEntryId: string,
    actor = "PAIR_MODEL_DISCOVERY",
  ): Record<string, unknown> {
    const rec = {
      claim_id: newId("MCL"),
      adapter_id: adapterId,
      model_entry_id: modelEntryId,
      claim,
      recorded_at: utcnow(),
    };
    this.store.put("model_claim_evidence", rec.claim_id, rec);
    void actor;
    return rec;
  }

  recordModelSnapshot(
    providerId: string,
    adapterId: string,
    status: string,
    claimedModelIds: string[],
    actor = "PAIR_MODEL_DISCOVERY",
  ): Record<string, unknown> {
    const rec = {
      snapshot_id: newId("MSN"),
      provider_id: providerId,
      adapter_id: adapterId,
      status,
      claimed_model_ids: [...claimedModelIds].sort(),
      recorded_at: utcnow(),
    };
    this.store.put("model_snapshot", rec.snapshot_id, rec);
    void actor;
    return rec;
  }

  /**
   * Absence reconciliation over the canonical provider's model set.
   * Models not claimed in a COMPLETE snapshot gain absence_streak; at the
   * threshold they become REMOVED — historical record retained, never
   * silently deleted.
   */
  reconcileAbsence(
    providerId: string,
    claimedIds: Set<string>,
    opts: { snapshotStatus?: string; threshold?: number; actor?: string } = {},
  ): { removed: string[]; reappeared: string[]; deprecatedCandidates: string[] } {
    const removed: string[] = [];
    const reappeared: string[] = [];
    const deprecatedCandidates: string[] = [];
    if (opts.snapshotStatus !== undefined && opts.snapshotStatus !== "COMPLETE") {
      return { removed, reappeared, deprecatedCandidates };
    }
    const threshold = opts.threshold ?? REMOVED_ABSENCE_THRESHOLD;
    for (const entry of this.listModels(providerId)) {
      const mid = String(entry.model_entry_id);
      if (claimedIds.has(mid)) continue;
      const body: Record<string, unknown> = { ...entry };
      body.version = Number(entry.version);
      const streak = Number(body.absence_streak ?? 0) + 1;
      body.absence_streak = streak;
      const conditions = new Set(body.conditions as string[]);
      if (streak >= threshold && !conditions.has("REMOVED")) {
        conditions.add("REMOVED");
        body.conditions = [...conditions].sort();
        removed.push(mid);
        this.put(mid, body, opts.actor ?? "PAIR_MODEL_DISCOVERY", "MODEL_STALE");
      } else if (streak >= 1) {
        conditions.add("STALE");
        body.conditions = [...conditions].sort();
        this.put(mid, body, opts.actor ?? "PAIR_MODEL_DISCOVERY", "MODEL_STALE");
      }
    }
    return { removed, reappeared, deprecatedCandidates };
  }

  recordProbeReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
    const pid = String(receipt.probe_id);
    this.store.put("probe_receipt", pid, receipt);
    const entry = this.getModel(String(receipt.model_entry_id));
    if (entry) {
      const body: Record<string, unknown> = { ...entry };
      body.version = Number(entry.version);
      const ids = new Set(body.probe_receipt_ids as string[]);
      ids.add(pid);
      body.probe_receipt_ids = [...ids];
      body.probe_state = receipt.result === "PASS" ? "PROBED" : `PROBE_${receipt.result}`;
      body.last_probe_at = utcnow();
      if (receipt.result === "PASS" && body.lifecycle_state === "DISCOVERED") {
        body.lifecycle_state = "PROBED";
      }
      // Evidence-backed capability claims promoted by probe evidence.
      const evidence = (receipt.capability_evidence ?? {}) as Record<string, unknown>;
      const claims = { ...(body.capability_claims as Record<string, string>) };
      for (const [k, v] of Object.entries(evidence)) {
        claims[k] = String(v);
      }
      body.capability_claims = claims;
      body.semantic_digest = modelSemanticDigest(body);
      this.put(String(entry.model_entry_id), body, "PAIR_MODEL_PROBE", receipt.result === "PASS" ? "MODEL_PROBED" : "MODEL_PROBE_FAILED");
    }
    return receipt;
  }

  listProbeReceipts(modelEntryId?: string): Array<Record<string, unknown>> {
    let receipts = this.store.list("probe_receipt");
    if (modelEntryId) receipts = receipts.filter((r) => r.model_entry_id === modelEntryId);
    return receipts.sort((a, b) => String(a.probe_id).localeCompare(String(b.probe_id)));
  }

  /** Phase E R2 §2 — the CURRENT-epoch probe receipts: only the receipts
   *  referenced by the entry's current probe_receipt_ids window. Older
   *  probe_receipt entities stay persisted/inspectable via
   *  listProbeReceipts but are never current authority.
   *  R3 §10 — ownership is verified too: a receipt in the window must
   *  actually belong to this model (model_entry_id match) and, when both
   *  sides carry provider_id, to the same provider — a corrupt/legacy
   *  window referencing another model's probe grants nothing. */
  currentProbeReceipts(modelEntryId: string): Array<Record<string, unknown>> {
    const entry = this.getModel(modelEntryId);
    const ids = new Set(((entry?.probe_receipt_ids as string[]) ?? []).map(String));
    if (ids.size === 0) return [];
    return (this.store.list("probe_receipt") as Record<string, unknown>[]).filter(
      (r) =>
        ids.has(String(r.probe_id)) &&
        String(r.model_entry_id) === modelEntryId &&
        (r.provider_id == null || entry?.provider_id == null ||
          String(r.provider_id) === String(entry.provider_id)),
    );
  }

  issueQualificationReceipt(
    modelEntryId: string,
    opts: { capability_scope: string[]; verifier: string; evidence_refs: string[]; actor?: string },
  ): Record<string, unknown> {
    const entry = this.getModel(modelEntryId);
    if (!entry) throw new NotFoundError(`model_entry:${modelEntryId}`);
    // Phase E R2 §4 — this seam mints QUALIFIED authority, so it must
    // validate canonical CURRENT-epoch probe evidence itself rather than
    // trust caller-provided strings. Every capability in scope must be
    // covered by a PASS probe_receipt referenced in the entry's CURRENT
    // probe_receipt_ids; every evidence_ref must point into that same
    // current window (foreign/historical refs are rejected).
    const currentIds = new Set((entry.probe_receipt_ids as string[]) ?? []);
    const currentReceipts = this.currentProbeReceipts(modelEntryId);
    const passCaps = new Set<string>();
    for (const r of currentReceipts) {
      if (r.result !== "PASS") continue;
      const ce = (r.capability_evidence ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(ce)) if (ce[k] === "PASS" || ce[k] === true) passCaps.add(k);
      if (r.probe_type && ce.passed !== false) passCaps.add(String(r.probe_type));
    }
    for (const cap of opts.capability_scope) {
      if (!passCaps.has(cap)) {
        throw new IntegrityError(
          "FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING",
          JSON.stringify({ model_entry_id: modelEntryId, capability: cap, current_probe_ids: [...currentIds] }),
        );
      }
    }
    // Phase E R3 §14 — the LATEST probe state governs: an older PASS in
    // the current window must not mint over a newer failure.
    if (String(entry.probe_state ?? "") !== "PROBED") {
      throw new IntegrityError(
        "FAIL_CLOSED_MODEL_QUALIFICATION_STATE",
        JSON.stringify({ model_entry_id: modelEntryId, probe_state: entry.probe_state ?? null }),
      );
    }
    for (const ref of opts.evidence_refs) {
      if (!currentIds.has(String(ref))) {
        throw new IntegrityError(
          "FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_FOREIGN",
          JSON.stringify({ model_entry_id: modelEntryId, evidence_ref: ref }),
        );
      }
    }
    // Phase E R3 §11 — the minted receipt records the ACTUAL covering
    // current PASS probe receipts (derived internally), never trusting
    // caller strings and never minting an untraceable receipt with empty
    // evidence.
    const covering = currentReceipts.filter((r) => {
      if (r.result !== "PASS") return false;
      const ce = (r.capability_evidence ?? {}) as Record<string, unknown>;
      return opts.capability_scope.some(
        (cap) =>
          ce[cap] === "PASS" ||
          ce[cap] === true ||
          (String(r.probe_type) === cap && ce.passed !== false),
      );
    });
    const receipt = {
      receipt_id: newId("MQR"),
      model_entry_id: modelEntryId,
      capability_scope: opts.capability_scope,
      verifier: opts.verifier,
      evidence_refs: covering.map((r) => String(r.probe_id)),
      // Phase E §7 — bind the receipt to the model's material identity at
      // qualification time so later drift cannot reuse stale authority.
      material_fingerprint: modelIdentityDigest(entry),
      issued_at: utcnow(),
    };
    this.store.put("model_qualification", receipt.receipt_id, receipt);
    const body: Record<string, unknown> = { ...entry };
    body.version = Number(entry.version);
    body.current_qualification_receipt_id = receipt.receipt_id;
    body.lifecycle_state = "QUALIFIED";
    body.last_qualified_at = receipt.issued_at;
    // Successful canonical qualification supersedes a historical STALE
    // marker — model state must not stay internally contradictory.
    // REMOVED/DEPRECATED/BLOCKED cannot reach here (qualification gates
    // fail first); REAPPEARED is informational history and is preserved.
    body.conditions = ((entry.conditions as string[]) ?? []).filter((c) => c !== "STALE").sort();
    this.put(modelEntryId, body, opts.actor ?? "PAIR_MODEL_CATALOG", "MODEL_QUALIFIED");
    return receipt;
  }

  setConditions(modelEntryId: string, conditions: string[], actor = "PAIR_MODEL_CATALOG") {
    const entry = this.getModel(modelEntryId);
    if (!entry) throw new NotFoundError(`model_entry:${modelEntryId}`);
    const body: Record<string, unknown> = { ...entry };
    body.version = Number(entry.version);
    body.conditions = [...conditions].sort();
    return this.put(modelEntryId, body, actor, "MODEL_ENTRY_UPDATED");
  }

  private put(eid: string, body: Record<string, unknown>, actor: string, eventType?: string) {
    const old = this.store.tryGet("model_entry", eid);
    const version = old ? Number(old.version) : 0;
    const saved = this.store.put("model_entry", eid, body, version);
    if (eventType) {
      this.store.event({
        entity_type: "model_entry",
        entity_id: eid,
        event_type: eventType,
        old_state: old ? String(old.lifecycle_state ?? null) : null,
        new_state: String(saved.lifecycle_state ?? null),
        actor,
      });
    }
    return saved;
  }
}
