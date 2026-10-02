/**
 * model-routable — executor↔provider↔model bindings + derived ROUTABLE
 * projection (P6).
 *
 * Extends the P3 routing-projection rule: ROUTABLE is COMPUTED from durable
 * state — never stored, never asserted by adapters. A binding row is
 * routable only when executor, provider, and model gates all pass.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { ModelEvidenceCatalog, modelIdentityDigest } from "./model-catalog.js";
import { PROVIDER_OK_STATES, ProviderCatalog, providerIdentityDigest } from "./provider-catalog.js";
import type { PairEvidenceStore } from "./store.js";
import type { PairControlPlane } from "./service.js";

export interface ModelBindingRow {
  binding_id: string;
  executor_id: string;
  provider_id: string;
  model_entry_id: string;
  transport_compat: string | null;
  qualification_state: string;
  evidence_refs: string[];
  first_seen_at: string;
  last_seen_at: string;
  binding_digest: string;
  version: number;
}

export function bindingDigest(b: Omit<ModelBindingRow, "binding_digest" | "version">): string {
  return digest({
    executor_id: b.executor_id,
    provider_id: b.provider_id,
    model_entry_id: b.model_entry_id,
    transport_compat: b.transport_compat,
  });
}

export function ensureBinding(
  service: PairControlPlane,
  opts: {
    executor_id: string;
    provider_id: string;
    model_entry_id: string;
    transport_compat?: string;
    evidence_refs?: string[];
    actor?: string;
  },
): ModelBindingRow {
  const store = service.store;
  // Phase E R1 §5 — mutation-time fail closed: a binding that names a
  // provider different from the model's canonical provider_id is an
  // authority mismatch, never created. (Orphan bindings for missing
  // models still mint as DISCOVERED — observability, never routable.)
  const model = new ModelEvidenceCatalog(store).getModel(opts.model_entry_id);
  if (
    model &&
    model.provider_id &&
    String(model.provider_id) !== String(opts.provider_id)
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH",
      JSON.stringify({
        binding_provider_id: opts.provider_id,
        model_provider_id: model.provider_id,
        model_entry_id: opts.model_entry_id,
      }),
    );
  }
  const provisional = {
    binding_id: "",
    executor_id: opts.executor_id,
    provider_id: opts.provider_id,
    model_entry_id: opts.model_entry_id,
    transport_compat: opts.transport_compat ?? null,
    qualification_state: "DISCOVERED",
    evidence_refs: opts.evidence_refs ?? [],
    first_seen_at: utcnow(),
    last_seen_at: utcnow(),
  };
  const bindingId = `MBD_${bindingDigest(provisional).slice(0, 24)}`;
  const existing = store.tryGet("model_binding", bindingId) as ModelBindingRow | null;
  if (existing) return existing;
  const body = { ...provisional, binding_id: bindingId };
  store.put("model_binding", bindingId, body, 0);
  store.event({
    entity_type: "model_binding",
    entity_id: bindingId,
    event_type: "MODEL_BINDING_DISCOVERED",
    new_state: "DISCOVERED",
    actor: opts.actor ?? "PAIR_MODEL_BINDING",
  });
  return { ...body, binding_digest: bindingDigest(body), version: 1 };
}

export function qualifyBinding(
  service: PairControlPlane,
  bindingId: string,
  opts: { evidence_refs?: string[]; actor?: string } = {},
): ModelBindingRow {
  const store = service.store;
  const existing = store.tryGet("model_binding", bindingId) as ModelBindingRow | null;
  if (!existing) throw new NotFoundError(`model_binding:${bindingId}`);
  // Phase E R1 §5 — fail closed before QUALIFIED authority exists: the
  // binding's provider_id must equal the model's canonical provider_id.
  const model = new ModelEvidenceCatalog(store).getModel(existing.model_entry_id);
  if (
    !model ||
    !model.provider_id ||
    String(model.provider_id) !== String(existing.provider_id)
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH",
      JSON.stringify({
        binding_id: bindingId,
        binding_provider_id: existing.provider_id,
        model_provider_id: model?.provider_id ?? null,
      }),
    );
  }
  const body = { ...existing };
  (body as unknown as Record<string, unknown>).version = Number(existing.version);
  body.qualification_state = "QUALIFIED";
  body.evidence_refs = [...new Set([...(body.evidence_refs ?? []), ...(opts.evidence_refs ?? [])])];
  body.last_seen_at = utcnow();
  store.put("model_binding", bindingId, body, Number(existing.version));
  store.event({
    entity_type: "model_binding",
    entity_id: bindingId,
    event_type: "MODEL_BINDING_QUALIFIED",
    old_state: existing.qualification_state,
    new_state: "QUALIFIED",
    actor: opts.actor ?? "PAIR_MODEL_BINDING",
  });
  return { ...body, version: Number(existing.version) + 1 };
}

export function rejectBinding(
  service: PairControlPlane,
  bindingId: string,
  reason: string,
  opts: { actor?: string } = {},
): ModelBindingRow {
  const store = service.store;
  const existing = store.tryGet("model_binding", bindingId) as ModelBindingRow | null;
  if (!existing) throw new NotFoundError(`model_binding:${bindingId}`);
  const body = { ...existing };
  (body as unknown as Record<string, unknown>).version = Number(existing.version);
  body.qualification_state = "REJECTED";
  body.last_seen_at = utcnow();
  store.put("model_binding", bindingId, body, Number(existing.version));
  store.event({
    entity_type: "model_binding",
    entity_id: bindingId,
    event_type: "MODEL_BINDING_REJECTED",
    old_state: existing.qualification_state,
    new_state: `REJECTED:${reason}`.slice(0, 120),
    actor: opts.actor ?? "PAIR_MODEL_BINDING",
  });
  return { ...body, version: Number(existing.version) + 1 };
}

export function listBindings(service: PairControlPlane): ModelBindingRow[] {
  return service.store.list("model_binding") as unknown as ModelBindingRow[];
}

export interface RoutableModelRow {
  binding_id: string;
  executor_id: string;
  provider_id: string;
  model_entry_id: string;
  routable: boolean;
  gates: Record<string, "PASS" | "FAIL">;
  reason_not_routable: string | null;
}

export interface ProviderModelEligibility {
  eligible: boolean;
  gates: Record<string, "PASS" | "FAIL">;
  reason: string | null;
}

/**
 * The provider+model subset of the routable gates — the canonical answer
 * to "is this provider/model currently usable at all". Shared by the
 * executor↔binding routable projection and by non-binding callers (e.g.
 * Planner candidates, which are not DSH bindings and skip the
 * executor/binding gates). Pure read — derives from durable state only.
 */
export function providerModelEligibility(
  store: PairEvidenceStore,
  providerId: string,
  modelEntryId: string,
): ProviderModelEligibility {
  const providerCatalog = new ProviderCatalog(store);
  const modelCatalog = new ModelEvidenceCatalog(store);
  const gates: Record<string, "PASS" | "FAIL"> = {};

  const provider = providerCatalog.getProvider(providerId);
  gates.PROVIDER_QUALIFIED =
    provider && PROVIDER_OK_STATES.has(String(provider.lifecycle_state)) ? "PASS" : "FAIL";
  // Phase E §4 — AUTH_REQUIRED is NOT usable authority: a credential-bound
  // provider becomes routable only when authorization is proven (AUTH_OK).
  gates.PROVIDER_AUTH_OK =
    provider && String(provider.auth_state) === "AUTH_OK" ? "PASS" : "FAIL";
  // Phase E §6 — a recorded probe FAILURE demotes routability (PROBE_*
  // outcome markers). Absence of probe evidence is not a contradiction:
  // PROVIDER_QUALIFIED already carries lifecycle authority.
  gates.PROVIDER_PROBE_CURRENT =
    provider && !String(provider.probe_state ?? "").startsWith("PROBE_") ? "PASS" : "FAIL";
  gates.PROVIDER_HEALTH_OK =
    provider && !["UNAVAILABLE", "DOWN"].includes(String(provider.health_state)) ? "PASS" : "FAIL";
  // Phase E §5 — REMOVED (absence-reconciled) providers are blocked like
  // DISABLED/UNQUALIFIED; history stays inspectable, authority is gone.
  gates.PROVIDER_NOT_BLOCKED =
    provider &&
    !((provider.conditions as string[]) ?? []).some((c) =>
      ["DISABLED", "UNQUALIFIED", "REMOVED"].includes(c),
    )
      ? "PASS"
      : "FAIL";
  // Phase E R1 §1 — STALE = NOT CURRENT = NOT ROUTABLE. The streak
  // threshold to REMOVED is historical classification only; the first
  // authoritative absence already revokes NEW-work authority.
  gates.PROVIDER_CURRENT =
    provider &&
    !((provider.conditions as string[]) ?? []).some((c) =>
      ["STALE", "REMOVED"].includes(c),
    )
      ? "PASS"
      : "FAIL";
  // Phase E §7 — the current qualification receipt must still bind to the
  // provider's present material identity: a receipt minted before identity
  // facets changed cannot authorize new work.
  const providerReceipt = provider?.current_qualification_receipt_id
    ? store.tryGet("provider_qualification", String(provider.current_qualification_receipt_id))
    : null;
  // Receipt validity only binds a provider claiming qualified authority —
  // a non-qualified provider already fails PROVIDER_QUALIFIED.
  gates.PROVIDER_RECEIPT_CURRENT =
    !provider || !PROVIDER_OK_STATES.has(String(provider.lifecycle_state)) ||
    (providerReceipt &&
      String(providerReceipt.material_fingerprint ?? "") === providerIdentityDigest(provider))
      ? "PASS"
      : "FAIL";

  const model = modelCatalog.getModel(modelEntryId);
  const modelConditions = (model?.conditions ?? []) as string[];
  // Phase E R1 §4 — provider↔model canonical linkage: the model's
  // authoritative provider_id must equal the candidate provider's id. A
  // malformed/corrupt binding (qualified P2 + model owned by P1) cannot
  // pass independent gates into routability.
  gates.MODEL_PROVIDER_MATCH =
    provider &&
    model &&
    String(model.provider_id ?? "") === String(provider.provider_id)
      ? "PASS"
      : "FAIL";
  // Phase E R1 §11 — an unresolved provider_id contradiction on the
  // canonical entry is an authority conflict: not silently routable.
  gates.MODEL_PROVIDER_IDENTITY_CONSISTENT =
    model &&
    !(((model.contradictions as Array<{ field?: string }>) ?? []).some(
      (c) => c.field === "provider_id",
    ))
      ? "PASS"
      : "FAIL";
  gates.MODEL_QUALIFIED = model?.lifecycle_state === "QUALIFIED" ? "PASS" : "FAIL";
  gates.MODEL_NOT_STALE =
    model && !modelConditions.includes("STALE") && !modelConditions.includes("REMOVED") ? "PASS" : "FAIL";
  gates.MODEL_NOT_REVOKED =
    model && !modelConditions.some((c) => ["REMOVED", "DEPRECATED", "BLOCKED"].includes(c)) ? "PASS" : "FAIL";
  gates.MODEL_AVAILABLE = model && !modelConditions.includes("UNAVAILABLE") ? "PASS" : "FAIL";
  // Phase E R1 §6 — model qualification must correspond to current model
  // identity AND provider ownership: missing receipt, missing fingerprint
  // (legacy pre-R1 row), or fingerprint mismatch all fail current
  // authority. Legacy fingerprint-less receipts stay historical evidence
  // (§7 policy A) — a fresh probe+qualification mints the bound receipt.
  const modelReceipt = model?.current_qualification_receipt_id
    ? store.tryGet("model_qualification", String(model.current_qualification_receipt_id))
    : null;
  gates.MODEL_RECEIPT_CURRENT =
    !model || model.lifecycle_state !== "QUALIFIED" ||
    (modelReceipt &&
      modelReceipt.material_fingerprint !== undefined &&
      String(modelReceipt.material_fingerprint) === modelIdentityDigest(model))
      ? "PASS"
      : "FAIL";

  const reason = Object.keys(gates).find((g) => gates[g] === "FAIL") ?? null;
  return { eligible: reason === null, gates, reason };
}

/**
 * Derived routable projection over model bindings. Pure read — writes
 * nothing, persists no computed routability.
 */
export function projectRoutableModels(service: PairControlPlane): RoutableModelRow[] {
  const executorRegistry = new ExecutorRegistry(service);
  const executorById = new Map<string, Record<string, unknown>>();
  for (const rec of service.listExecutors()) {
    executorById.set(String(rec.executor_id), executorRegistry.normalizeDescriptor(rec));
  }

  const rows: RoutableModelRow[] = [];
  for (const binding of listBindings(service)) {
    const gates: Record<string, "PASS" | "FAIL"> = {};

    const executor = executorById.get(binding.executor_id);
    gates.EXECUTOR_REGISTERED = executor ? "PASS" : "FAIL";
    gates.EXECUTOR_ENABLED = executor && executor.availability_state === "AVAILABLE" ? "PASS" : "FAIL";
    gates.EXECUTOR_QUALIFIED = executor?.qualification_state === "QUALIFIED" ? "PASS" : "FAIL";
    gates.EXECUTOR_HEALTHY = executor?.health_state === "READY" ? "PASS" : "FAIL";

    // Provider+model gates come from the shared canonical subset so
    // routable and planner eligibility can never disagree (R2).
    Object.assign(gates, providerModelEligibility(service.store, binding.provider_id, binding.model_entry_id).gates);

    gates.BINDING_QUALIFIED = binding.qualification_state === "QUALIFIED" ? "PASS" : "FAIL";

    const reason = Object.keys(gates).find((g) => gates[g] === "FAIL") ?? null;
    rows.push({
      binding_id: binding.binding_id,
      executor_id: binding.executor_id,
      provider_id: binding.provider_id,
      model_entry_id: binding.model_entry_id,
      routable: reason === null,
      gates,
      reason_not_routable: reason,
    });
  }
  return rows;
}
