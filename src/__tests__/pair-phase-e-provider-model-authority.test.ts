/**
 * PHASE E — PROVIDER / MODEL OPERATIONAL AUTHORITY CLOSURE (test matrix §21)
 *
 * A  startup authority      B  auth          C  provider currentness
 * D  models                 E  identities    F  qualification evidence
 * G  binding                H  roles         I  secret governance
 * J  runtime re-proof       K  concurrency / idempotency
 *
 * Every section pins the Phase E closures: discovery != qualification !=
 * role != binding != routability; enumeration-only bootstrap carries no
 * runtime authority; stale receipts/contradicting probes demote.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CredentialEnvSource,
  DSH_EXECUTOR_ID,
  DshExecutorAdapter,
  MODEL_ROLE,
  ModelEvidenceCatalog,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  ProviderValidator,
  PROVIDER_DISCOVERY_SCAN_STATES,
  PROVIDER_OK_STATES,
  PROVIDER_QUALIFICATION_REQUIRED_GATES,
  PROVIDER_REMOVED_ABSENCE_THRESHOLD,
  assignModelRole,
  assertCanonicalModelRoleStateDisjoint,
  assertDshCandidateEligible,
  assertPlannerCandidateEligible,
  canonicalModelId,
  createDshModelRouter,
  ensureBinding,
  listBindings,
  modelIdentityDigest,
  projectRoutableModels,
  providerEntryId,
  providerIdentityDigest,
  providerModelEligibility,
  providerRoutableGate,
  qualifyBinding,
  reconcileModelRoleAssignments,
  registerGovernedExecutors,
  registerSensitiveMaterial,
  qualifyModel,
  resolveConfiguredModelRoleRoute,
  runModelDiscovery,
  runProviderDiscovery,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phe-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const makeCtx = (name: string) => {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  return { dir, store, service };
};

const CLAIM = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) => ({
  provider_id: providerId,
  provider_family: providerId,
  model_id: modelId,
  display_name: modelId,
  capability_hints: ["text_inference"],
  status_hint: "LISTED",
  observed_at: "2026-01-01T00:00:00Z",
  ...extra,
});

class StubAdapter {
  readonly adapterId = "STUB";
  constructor(
    private readonly claims: ReturnType<typeof CLAIM>[],
    private readonly fail?: Error,
  ) {}
  supports(): boolean {
    return true;
  }
  async listModels(): Promise<ReturnType<typeof CLAIM>[]> {
    if (this.fail) throw this.fail;
    return this.claims;
  }
  classifyError(err: unknown): string {
    return err instanceof Error && /401|403/.test(err.message) ? "ACCESS_DENIED" : "UNREACHABLE";
  }
}

/** Provider seeded via canonical discovery claim. */
const seedDiscovered = (store: PairEvidenceStore, pid: string, sourceId = "OPERATOR_MANIFEST") => {
  const cat = new ProviderCatalog(store);
  cat.upsertCandidate(
    {
      provider_native_id: pid,
      canonical_hint: pid,
      source_id: sourceId,
      display_name: pid,
      provider_type: "OPENAI_COMPATIBLE",
      protocol_family: "OPENAI_COMPATIBLE",
      provider_family: pid,
      endpoint_reference: `https://api.${pid}.test/v1`,
      credential_reference_name: `${pid.toUpperCase()}_KEY`,
    },
    "test",
  );
  return cat.getProvider(pid)!;
};

/** Canonical qualified provider: real validateAccess(probe) + qualify() chain. */
const qualifyProvider = (store: PairEvidenceStore, pid: string, env: Record<string, string> = {}) => {
  const v = new ProviderValidator(store);
  return v.qualify(pid, { env, actor: "test" });
};

const mkQualifiedProvider = async (
  store: PairEvidenceStore,
  pid: string,
  env: Record<string, string> = {},
) => {
  seedDiscovered(store, pid);
  const v = new ProviderValidator(store);
  await v.validateAccess(pid, {
    env: { [`${pid.toUpperCase()}_KEY`]: "cred", ...env },
    probe: async () => ({ outcome: "AUTH_OK", latency_ms: 5 }),
  });
  return qualifyProvider(store, pid, { [`${pid.toUpperCase()}_KEY`]: "cred", ...env });
};

/** R2 — canonical qualification mirrors production: a durable PASS probe
 *  receipt in the model's CURRENT epoch, then the real qualification
 *  gates. Fixtures must never mint receipts directly. */
const mkModel = (store: PairEvidenceStore, pid: string, mid: string, qualified = true) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim(CLAIM(pid, mid));
  const eid = String(entry.model_entry_id);
  if (qualified) {
    mcat.recordProbeReceipt({
      probe_id: `PRB_${pid}_${mid}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      model_entry_id: eid,
      provider_id: pid,
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
      detail: "fixture-probe",
    });
    const q = qualifyModel(store, eid, { capability_scope: ["text_inference"], actor: "t" });
    if (!q.qualified) throw new Error(`mkModel fixture failed: ${JSON.stringify(q.gates)}`);
  }
  return eid;
};

const registerDsh = (service: PairControlPlane, adapter: DshExecutorAdapter) =>
  registerGovernedExecutors(service, new Map([[DSH_EXECUTOR_ID, adapter]]), "t");

/* ============================ A — startup authority ==================== */

describe("A — startup authority", () => {
  it("A1: DISCOVERY_ELIGIBLE carries NO runtime routing authority", () => {
    const { store } = makeCtx("a1");
    seedDiscovered(store, "pv");
    const cat = new ProviderCatalog(store);
    cat.setLifecycle("pv", "DISCOVERY_ELIGIBLE");
    expect(PROVIDER_DISCOVERY_SCAN_STATES.has("DISCOVERY_ELIGIBLE")).toBe(true);
    expect(PROVIDER_OK_STATES.has("DISCOVERY_ELIGIBLE")).toBe(false);
    const me = mkModel(store, "pv", "m1");
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.eligible).toBe(false);
    expect(elig.gates.PROVIDER_QUALIFIED).toBe("FAIL");
    expect(providerRoutableGate(cat.getProvider("pv")!).pass).toBe(false);
  });

  it("A2: enumeration scans a DISCOVERY_ELIGIBLE provider but grants nothing more", async () => {
    const { store } = makeCtx("a2");
    seedDiscovered(store, "pv");
    new ProviderCatalog(store).setLifecycle("pv", "DISCOVERY_ELIGIBLE");
    const res = await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    expect(res.scanned).toContain("pv");
    const p = new ProviderCatalog(store).getProvider("pv")!;
    expect(p.lifecycle_state).toBe("DISCOVERY_ELIGIBLE"); // never promoted
    expect(p.current_qualification_receipt_id ?? null).toBeNull();
    const me = new ModelEvidenceCatalog(store).getModelByIds("pv", "m1")!;
    expect(me.lifecycle_state).toBe("DISCOVERED");
    expect(providerModelEligibility(store, "pv", String(me.model_entry_id)).eligible).toBe(false);
  });

  it("A3: model discovery bootstrap cannot inflate routing authority (gates still fail)", async () => {
    const { store } = makeCtx("a3");
    seedDiscovered(store, "pv");
    const cat = new ProviderCatalog(store);
    cat.setLifecycle("pv", "DISCOVERY_ELIGIBLE");
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    const me = new ModelEvidenceCatalog(store).getModelByIds("pv", "m1")!;
    const gates = providerModelEligibility(store, "pv", String(me.model_entry_id)).gates;
    expect(gates.PROVIDER_QUALIFIED).toBe("FAIL");
    expect(gates.MODEL_QUALIFIED).toBe("FAIL");
    expect(gates.PROVIDER_RECEIPT_CURRENT).toBe("PASS"); // not qualified → receipt gate N/A
  });
});

/* ============================ B — auth ================================= */

describe("B — auth", () => {
  it("B1: missing required credential → CREDENTIAL_MISSING → not routable", async () => {
    const { store } = makeCtx("b1");
    seedDiscovered(store, "pv");
    const v = new ProviderValidator(store);
    const res = await v.validateAccess("pv", { env: {} });
    expect(res.outcome).toBe("CREDENTIAL_MISSING");
    const q = v.qualify("pv", { env: {} });
    expect(q.qualified).toBe(false);
    expect(q.gates.AUTH_ACCEPTABLE).toBe("FAIL");
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(providerRoutableGate(new ProviderCatalog(store).getProvider("pv")!).pass).toBe(false);
  });

  it("B2: AUTH_REQUIRED (unresolved credential-bound provider) is never routable", () => {
    const { store } = makeCtx("b2");
    const e = seedDiscovered(store, "pv");
    const id = String(e.entry_id);
    const b = store.get("provider", id);
    // R3 §5 — the receipt commits only over canonical durable state: mint
    // while AUTH_OK, then revoke auth (the production "credential revoked
    // after qualification" state this test targets).
    store.put("provider", id, { ...b, lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK", probe_state: "PROBED" }, Number(b.version));
    const cat = new ProviderCatalog(store);
    cat.issueQualificationReceipt("pv", { policy_version: "t", actor: "t" });
    const b2 = store.get("provider", id);
    store.put("provider", id, { ...b2, auth_state: "AUTH_REQUIRED" }, Number(b2.version));
    // AUTH_REQUIRED still fails PROVIDER_AUTH_OK even with a valid receipt.
    const me = mkModel(store, "pv", "m1");
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(elig.eligible).toBe(false);
  });

  it("B3: AUTH_OK + canonical gates → eligible", async () => {
    const { store } = makeCtx("b3");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const elig = providerModelEligibility(store, "pv", me);
    expect(Object.values(elig.gates).every((g) => g === "PASS")).toBe(true);
    expect(elig.eligible).toBe(true);
  });

  it("B4: credential revoked after qualification → route disappears", async () => {
    const { store } = makeCtx("b4");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
    // Credential env disappears → canonical re-validation demotes auth state.
    const v = new ProviderValidator(store);
    await v.validateAccess("pv", { env: {} });
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    expect(providerRoutableGate(new ProviderCatalog(store).getProvider("pv")!).pass).toBe(false);
  });
});

/* ====================== C — provider currentness ======================= */

describe("C — provider currentness", () => {
  const srcA = (ids: string[]) =>
    new CredentialEnvSource(ids.map((p) => ({ provider_id: p, env_name: `${p.toUpperCase()}_KEY` })));

  it("C1: disappeared from sole authoritative source → STALE → REMOVED", async () => {
    const { store } = makeCtx("c1");
    const env = { PV_KEY: "cred" };
    const s1 = srcA(["pv"]);
    const s0 = srcA([]); // same source, provider absent
    const cat = new ProviderCatalog(store);
    runProviderDiscovery(store, { context: { env }, sources: [s1] });
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD - 1; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [s0] });
    }
    let p = cat.getProvider("pv")!;
    expect(p.conditions).toContain("STALE");
    expect(p.conditions).not.toContain("REMOVED");
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD - 1; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [s0] });
    }
    p = cat.getProvider("pv")!;
    expect(p.conditions).toContain("REMOVED");
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_NOT_BLOCKED).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    // history preserved — row still inspectable, never deleted
    expect(p.provider_id).toBe("pv");
  });

  it("C2: still claimed by a second source → stays current despite first absence", () => {
    const { store } = makeCtx("c2");
    const env = { PV_KEY: "cred", OTHER_KEY: "cred" };
    const sa = srcA(["pv"]);
    const sb = srcA(["pv", "other"]);
    runProviderDiscovery(store, { context: { env }, sources: [sa, sb] });
    // Source A stops observing pv; source B still sees it → no STALE.
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD + 1; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [srcA([]), sb] });
    }
    const p = new ProviderCatalog(store).getProvider("pv")!;
    expect(p.conditions ?? []).not.toContain("STALE");
    expect(p.conditions ?? []).not.toContain("REMOVED");
  });

  it("C3: restart does not resurrect a REMOVED provider", () => {
    const { store, dir } = makeCtx("c3");
    const env = { PV_KEY: "cred" };
    runProviderDiscovery(store, { context: { env }, sources: [srcA(["pv"])] });
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [srcA([])] });
    }
    expect(new ProviderCatalog(store).getProvider("pv")!.conditions).toContain("REMOVED");
    store.close();
    const reopened = new PairEvidenceStore(path.join(dir, "pair.db"));
    const p = new ProviderCatalog(reopened).getProvider("pv")!;
    expect(p.conditions).toContain("REMOVED");
    expect(Number(p.absence_streak)).toBeGreaterThanOrEqual(PROVIDER_REMOVED_ABSENCE_THRESHOLD);
    reopened.close();
  });

  it("C4: reappearance follows the normal lifecycle — REAPPEARED, no silent re-auth", async () => {
    const { store } = makeCtx("c4");
    const env = { PV_KEY: "cred" };
    runProviderDiscovery(store, { context: { env }, sources: [srcA(["pv"])] });
    await mkQualifiedProvider(store, "pv");
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [srcA([])] });
    }
    const cat = new ProviderCatalog(store);
    expect(cat.getProvider("pv")!.conditions).toContain("REMOVED");
    // R1 §2 — re-observation clears REMOVED→REAPPEARED and drops the entry
    // back to DISCOVERY_ELIGIBLE observation state: re-appearance restores
    // OBSERVATION only, never prior runtime authority.
    runProviderDiscovery(store, { context: { env }, sources: [srcA(["pv"])] });
    const p = cat.getProvider("pv")!;
    expect(p.conditions).toContain("REAPPEARED");
    expect(p.conditions).not.toContain("REMOVED");
    expect(Number(p.absence_streak)).toBe(0);
  });
});

/* ============================ D — models =============================== */

describe("D — models", () => {
  const REMOVED_THRESHOLD = 3;

  it("D1: COMPLETE snapshots missing a model → STALE then REMOVED", async () => {
    const { store } = makeCtx("d1");
    const cat = new ProviderCatalog(store);
    seedDiscovered(store, "pv");
    cat.setLifecycle("pv", "MODEL_DISCOVERY_ELIGIBLE");
    const adapter = new StubAdapter([CLAIM("pv", "m1"), CLAIM("pv", "m2")]);
    await runModelDiscovery(store, { adapters: [adapter] });
    const m1 = new ModelEvidenceCatalog(store).getModelByIds("pv", "m1")!;
    const absent = new StubAdapter([CLAIM("pv", "m2")]);
    await runModelDiscovery(store, { adapters: [absent] });
    const after1 = new ModelEvidenceCatalog(store).getModel(String(m1.model_entry_id))!;
    expect(after1.conditions).toContain("STALE");
    for (let i = 0; i < REMOVED_THRESHOLD - 1; i++) {
      await runModelDiscovery(store, { adapters: [absent] });
    }
    const finalM1 = new ModelEvidenceCatalog(store).getModel(String(m1.model_entry_id))!;
    expect(finalM1.conditions).toContain("REMOVED");
    expect(providerModelEligibility(store, "pv", String(m1.model_entry_id)).gates.MODEL_NOT_REVOKED).toBe("FAIL");
  });

  it("D2: FAILED snapshot never removes", async () => {
    const { store } = makeCtx("d2");
    const cat = new ProviderCatalog(store);
    seedDiscovered(store, "pv");
    cat.setLifecycle("pv", "MODEL_DISCOVERY_ELIGIBLE");
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    for (let i = 0; i < REMOVED_THRESHOLD + 1; i++) {
      await runModelDiscovery(store, {
        adapters: [new StubAdapter([], new Error("HTTP_401"))],
      });
    }
    const m1 = new ModelEvidenceCatalog(store).getModelByIds("pv", "m1")!;
    expect(m1.conditions ?? []).not.toContain("REMOVED");
    expect(m1.conditions ?? []).not.toContain("STALE");
  });

  it("D3: REMOVED model cannot route through a binding", async () => {
    const { store, service } = makeCtx("d3");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("d3j"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
    });
    registerDsh(service, adapter);
    const b = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(service, String(b.binding_id));
    const mcat = new ModelEvidenceCatalog(store);
    const body = mcat.getModel(me)!;
    store.put("model_entry", me, { ...body, conditions: ["REMOVED"] }, Number(body.version));
    const rows = projectRoutableModels(service);
    expect(rows).toHaveLength(1);
    expect(rows[0].routable).toBe(false);
    expect(rows[0].gates.MODEL_NOT_REVOKED).toBe("FAIL");
  });

  it("D4: reappearing model reuses the same entry — no duplicate", async () => {
    const { store } = makeCtx("d4");
    const cat = new ProviderCatalog(store);
    seedDiscovered(store, "pv");
    cat.setLifecycle("pv", "MODEL_DISCOVERY_ELIGIBLE");
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    const eid1 = canonicalModelId("pv", "m1");
    const absent = new StubAdapter([]);
    for (let i = 0; i < REMOVED_THRESHOLD; i++) {
      await runModelDiscovery(store, { adapters: [absent] });
    }
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    const models = new ModelEvidenceCatalog(store).listModels().filter((m) => m.provider_family === "pv");
    expect(models).toHaveLength(1);
    expect(String(models[0].model_entry_id)).toBe(eid1);
    expect(models[0].conditions).toContain("REAPPEARED");
  });
});

/* ============================ E — identities =========================== */

describe("E — identities", () => {
  it("E1: same provider rediscovery → same provider entry", () => {
    const { store } = makeCtx("e1");
    const env = { PV_KEY: "cred" };
    runProviderDiscovery(store, { context: { env }, sources: [new CredentialEnvSource([{ provider_id: "pv", env_name: "PV_KEY" }])] });
    const id1 = providerEntryId("pv");
    runProviderDiscovery(store, { context: { env }, sources: [new CredentialEnvSource([{ provider_id: "pv", env_name: "PV_KEY" }])] });
    const cat = new ProviderCatalog(store);
    expect(cat.listProviders()).toHaveLength(1);
    expect(String(cat.getProvider("pv")!.entry_id)).toBe(id1);
  });

  it("E2: same model rediscovery → same model_entry_id", async () => {
    const { store } = makeCtx("e2");
    const cat = new ProviderCatalog(store);
    seedDiscovered(store, "pv");
    cat.setLifecycle("pv", "MODEL_DISCOVERY_ELIGIBLE");
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    await runModelDiscovery(store, { adapters: [new StubAdapter([CLAIM("pv", "m1")])] });
    expect(new ModelEvidenceCatalog(store).listModels()).toHaveLength(1);
  });

  it("E3: distinct providers never collapse; a conflicting provider_id claim records a contradiction", () => {
    const { store } = makeCtx("e3");
    const mcat = new ModelEvidenceCatalog(store);
    mcat.upsertModelClaim(CLAIM("p1", "shared-model"));
    // A second claim resolving to the SAME canonical entry (same
    // provider_family+model_id) but naming a different provider_id is
    // recorded as a contradiction — never a flip of the first-seen link.
    const eid = canonicalModelId("p1", "shared-model");
    mcat.upsertModelClaim({ ...CLAIM("p2", "shared-model"), provider_family: "p1" });
    const entry = mcat.getModel(eid)!;
    expect(String(entry.provider_id)).toBe("p1");
    const contradictions = (entry.contradictions as unknown[]) ?? [];
    expect(contradictions.length).toBeGreaterThan(0);
    expect(providerEntryId("p1")).not.toBe(providerEntryId("p2"));
  });

  it("E4: configured route resolves through canonical provider/model authority", () => {
    const { store } = makeCtx("e4");
    const mcat = new ModelEvidenceCatalog(store);
    mcat.upsertModelClaim(CLAIM("pv", "m1"));
    const ref = resolveConfiguredModelRoleRoute(
      (p, m) => mcat.getModelByIds(p, m),
      { route: "pv:m1", role: MODEL_ROLE.PLANNER_COORDINATOR },
    );
    expect(String(ref.model_entry_id)).toBe(canonicalModelId("pv", "m1"));
    expect(() =>
      resolveConfiguredModelRoleRoute((p, m) => mcat.getModelByIds(p, m), {
        route: "pv:does-not-exist",
        role: MODEL_ROLE.PLANNER_COORDINATOR,
      }),
    ).toThrow(/FAIL_CLOSED/);
  });
});

/* ======================= F — qualification evidence ==================== */

describe("F — qualification evidence", () => {
  it("F1: receipt minted before an identity-facet change cannot grant current routing", async () => {
    const { store } = makeCtx("f1");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
    // Identity drift: endpoint material changed after qualification —
    // the receipt fingerprint no longer binds the current provider.
    const cat = new ProviderCatalog(store);
    const p = cat.getProvider("pv")!;
    const id = String(p.entry_id);
    store.put(
      "provider",
      id,
      { ...p, configured_endpoint_identity: "https://evil.example.test/v1", endpoint_reference: "https://evil.example.test/v1" },
      Number(p.version),
    );
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_RECEIPT_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
  });

  it("F2: stale/missing model receipt cannot grant current routing", async () => {
    const { store } = makeCtx("f2");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    // A QUALIFIED model whose receipt_id points nowhere → FAIL.
    const body = mcat.getModel(me)!;
    const realReceipt = String(body.current_qualification_receipt_id);
    store.put("model_entry", me, { ...body, current_qualification_receipt_id: "MQR_missing" }, Number(body.version));
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_RECEIPT_CURRENT).toBe("FAIL");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(false);
    // A receipt whose material_fingerprint no longer binds the entry → FAIL.
    const receipt = store.get("model_qualification", realReceipt);
    store.put(
      "model_qualification",
      realReceipt,
      { ...receipt, material_fingerprint: "0000000000000000" },
      Number(receipt.version),
    );
    const body2 = mcat.getModel(me)!;
    store.put("model_entry", me, { ...body2, current_qualification_receipt_id: realReceipt }, Number(body2.version));
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_RECEIPT_CURRENT).toBe("FAIL");
    // Restoring the binding fingerprint restores the gate.
    const rec2 = store.get("model_qualification", realReceipt);
    store.put(
      "model_qualification",
      realReceipt,
      { ...rec2, material_fingerprint: modelIdentityDigest(mcat.getModel(me)!) },
      Number(rec2.version),
    );
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_RECEIPT_CURRENT).toBe("PASS");
  });

  it("F3: valid current receipts + evidence → eligible end to end", async () => {
    const { store } = makeCtx("f3");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const model = new ModelEvidenceCatalog(store).getModel(me)!;
    const receipt = store.get("model_qualification", String(model.current_qualification_receipt_id));
    expect(String(receipt.material_fingerprint)).toBe(modelIdentityDigest(model));
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

/* ============================ G — binding ============================== */

describe("G — binding", () => {
  it("G1/G2/G3/G4: orphan, inactive provider, REMOVED model non-routable; valid chain routable", async () => {
    const { store, service } = makeCtx("g");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("gj"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    });
    registerDsh(service, adapter);
    const b = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    // G4 — qualified binding + all gates → routable.
    qualifyBinding(service, String(b.binding_id));
    let rows = projectRoutableModels(service);
    expect(rows[0].routable).toBe(true);
    // G3 — model REMOVED → non-routable.
    const mbody = new ModelEvidenceCatalog(store).getModel(me)!;
    store.put("model_entry", me, { ...mbody, conditions: ["REMOVED"] }, Number(mbody.version));
    rows = projectRoutableModels(service);
    expect(rows[0].routable).toBe(false);
    const mrestore = store.get("model_entry", me);
    store.put("model_entry", me, { ...mrestore, conditions: [] }, Number(mrestore.version));
    // G2 — provider demoted to DISCOVERED → non-routable.
    const p = new ProviderCatalog(store).getProvider("pv")!;
    store.put("provider", String(p.entry_id), { ...p, lifecycle_state: "DISCOVERED" }, Number(p.version));
    rows = projectRoutableModels(service);
    expect(rows[0].routable).toBe(false);
    expect(rows[0].gates.PROVIDER_QUALIFIED).toBe("FAIL");
    const prestore = store.get("provider", String(p.entry_id));
    store.put("provider", String(p.entry_id), { ...prestore, lifecycle_state: String(p.lifecycle_state) }, Number(prestore.version));
    // G1 — binding to a nonexistent model is an orphan row: still surfaced
    // in the projection with failing gates, inspectable, never routable.
    const orphan = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: "ME_nonexistent",
      transport_compat: "OPENAI_COMPLETIONS",
    });
    expect(listBindings(service).map((x) => x.binding_id)).toContain(orphan.binding_id);
    rows = projectRoutableModels(service);
    const orow = rows.find((r) => String(r.model_entry_id) === "ME_nonexistent")!;
    expect(orow.routable).toBe(false);
  });
});

/* ============================ H — roles ================================ */

describe("H — roles", () => {
  it("H1/H2: Planner/DSH pools stay disjoint; each side throws on overlap", async () => {
    const { store, service } = makeCtx("h12");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("hj"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    });
    registerDsh(service, adapter);
    ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(service, String(listBindings(service)[0].binding_id));
    // H1 — planner-role model is REFUSED by the DSH eligibility gate.
    expect(() =>
      assertDshCandidateEligible(service, { ref: "pv:m1", pid: "pv", mid: "m1", model_entry_id: me }, DSH_EXECUTOR_ID),
    ).toThrow(/FAIL_CLOSED/);
    // planner pool still accepts it.
    expect(() => assertPlannerCandidateEligible(store, me)).not.toThrow();
    // H2 — a DSH-role model is REFUSED by the planner eligibility gate.
    const me2 = mkModel(store, "pv", "m2");
    assignModelRole(store, me2, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    expect(() => assertPlannerCandidateEligible(store, me2)).toThrow(/FAIL_CLOSED_MODEL_ROLE_MISMATCH|FAIL_CLOSED/);
    // desired-state overlap is rejected before any mutation.
    const overlap = [{ model_entry_id: me, ref: "pv:m1", pid: "pv", mid: "m1", role: MODEL_ROLE.PLANNER_COORDINATOR }];
    expect(() =>
      reconcileModelRoleAssignments(store, { planner: overlap, dsh: overlap, actor: "t" }),
    ).toThrow();
    assertCanonicalModelRoleStateDisjoint(store);
  });

  it("H3: unresolved configured route fails closed at resolve", () => {
    const { store } = makeCtx("h3");
    const mcat = new ModelEvidenceCatalog(store);
    expect(() =>
      resolveConfiguredModelRoleRoute((p, m) => mcat.getModelByIds(p, m), {
        route: "pv:nope",
        role: MODEL_ROLE.DSH_EXECUTION,
      }),
    ).toThrow();
  });

  it("H4: role reconcile remains atomic and idempotent", async () => {
    const { store } = makeCtx("h4");
    await mkQualifiedProvider(store, "pv");
    const me1 = mkModel(store, "pv", "m1");
    const me2 = mkModel(store, "pv", "m2");
    const refs1 = [{ model_entry_id: me1, ref: "pv:m1", pid: "pv", mid: "m1", role: MODEL_ROLE.PLANNER_COORDINATOR }];
    const refs2 = [{ model_entry_id: me2, ref: "pv:m2", pid: "pv", mid: "m2", role: MODEL_ROLE.DSH_EXECUTION }];
    reconcileModelRoleAssignments(store, { planner: refs1, dsh: refs2, actor: "t" });
    assertCanonicalModelRoleStateDisjoint(store);
    reconcileModelRoleAssignments(store, { planner: refs1, dsh: refs2, actor: "t" });
    assertCanonicalModelRoleStateDisjoint(store);
  });
});

/* ========================= I — secret governance ======================= */

describe("I — secret governance", () => {
  it("I1: raw credential in a provider payload fails closed", () => {
    const { store } = makeCtx("i1");
    expect(() =>
      new ProviderCatalog(store).upsertCandidate(
        {
          provider_native_id: "pv",
          canonical_hint: "pv",
          source_id: "OPERATOR_MANIFEST",
          api_key: "sk-live-secret",
        },
        "t",
      ),
    ).toThrow(/FAIL_CLOSED_SECRET_VALUE_IN_PROVIDER_PAYLOAD/);
  });

  it("I2: credential_reference_name (a NAME, not a value) is allowed", () => {
    const { store } = makeCtx("i2");
    seedDiscovered(store, "pv");
    expect(new ProviderCatalog(store).getProvider("pv")!.credential_reference_name).toBe("PV_KEY");
  });

  it("I3 + I4: credential echoed in an external error is redacted before persistence AND before MC output", async () => {
    const { store, service } = makeCtx("i34");
    const secret = "sk-live-token-9f8e7d6c5b4a";
    registerSensitiveMaterial(secret);
    seedDiscovered(store, "pv");
    const cat = new ProviderCatalog(store);
    const e = cat.getProvider("pv")!;
    await new ProviderValidator(store).validateAccess("pv", {
      env: { PV_KEY: secret },
      probe: async () => {
        throw new Error(`remote 500: Authorization Bearer ${secret} rejected`);
      },
    });
    const events = store.listEvents("provider", String(e.entry_id));
    const probeEvt = events.find((ev) => String(ev.event_type) === "PROVIDER_PROBE_FAILED")!;
    const serialized = JSON.stringify(probeEvt);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED:SECRET_MATERIAL]");
    // MC-side projection source (store rows + events) carries no secret
    // either — MissionControl.providers() serializes exactly these rows.
    expect(JSON.stringify(store.list("provider"))).not.toContain(secret);
    expect(JSON.stringify(store.listEvents())).not.toContain(secret);
    void service;
  });
});

/* ============================ J — runtime ============================== */

describe("J — runtime", () => {
  it("J1: Planner re-proves eligibility — demoted provider throws before invocation", async () => {
    const { store } = makeCtx("j1");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(() => assertPlannerCandidateEligible(store, me)).not.toThrow();
    // Probe failure demotes the provider → next invocation throws.
    const p = new ProviderCatalog(store).getProvider("pv")!;
    new ProviderCatalog(store).recordProbeObservation("pv", "UNREACHABLE", { detail: "down", actor: "t" });
    store.put("provider", String(p.entry_id), { ...new ProviderCatalog(store).getProvider("pv")!, auth_state: "UNREACHABLE" }, Number(new ProviderCatalog(store).getProvider("pv")!.version));
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
  });

  it("J2/J4: DSH re-proves eligibility per invocation — revoked model stops new dispatch", async () => {
    const { store, service } = makeCtx("j2");
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    assignModelRole(store, me, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("j2j"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    });
    registerDsh(service, adapter);
    const b = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(service, String(b.binding_id));
    const cand = { ref: "pv:m1", pid: "pv", mid: "m1", model_entry_id: me };
    createDshModelRouter({ service, executorId: DSH_EXECUTOR_ID, candidates: [cand] });
    expect(() => assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID)).not.toThrow();
    const mbody = new ModelEvidenceCatalog(store).getModel(me)!;
    store.put("model_entry", me, { ...mbody, conditions: ["REMOVED"] }, Number(mbody.version));
    expect(() => assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID)).toThrow(/FAIL_CLOSED/);
  });

  it("J3: governed DSH dispatch with an unbound router FAILS CLOSED — no env-route bypass", async () => {
    const dir = freshDir("j3");
    const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(dir, "journal"),
      envReader: () => "cred",
      launchOverride: { command: "node", args: ["nonexistent-agent.mjs", "--profile", "acp"] },
      // NO router bound, NO compatEnvRouteFallback → governed dispatch must
      // fail closed rather than execute a raw configured route.
    });
    const disp = adapter.dispatch({
      governed_task_id: `GTSK_J3_${counter}`,
      mission_id: "MSN_J3",
      task_id: "TSK_J3",
      correlation_id: "corr-j3",
      executor_id: DSH_EXECUTOR_ID,
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      governance_digest: "d",
      workspace,
      allowed_paths: [workspace],
      task_instruction: "noop",
      timeout: 10,
    } as never);
    const eid = String(disp.execution_id);
    let term: Record<string, unknown> | null = null;
    for (let i = 0; i < 100 && !term; i++) {
      const o = adapter.observe(eid);
      if (["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"].includes(String(o.status))) term = o;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(term).toBeTruthy();
    expect(String(term!.status)).toBe("FAILED");
    const result = JSON.parse(
      fs.readFileSync(path.join(String(term!.run_root), "result.json"), "utf8"),
    ) as Record<string, unknown>;
    const err = result.error as Record<string, unknown> | null;
    expect(String(err?.class ?? err?.message ?? JSON.stringify(result))).toContain(
      "FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND",
    );
  });
});

/* ================== K — concurrency / idempotency ====================== */

describe("K — concurrency / idempotency", () => {
  it("K1/K2: repeated refresh + restart produce no duplicate authority", () => {
    const { store, dir } = makeCtx("k12");
    const env = { PV_KEY: "cred" };
    const src = new CredentialEnvSource([{ provider_id: "pv", env_name: "PV_KEY" }]);
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    let cat = new ProviderCatalog(store);
    expect(cat.listProviders()).toHaveLength(1);
    store.close();
    const reopened = new PairEvidenceStore(path.join(dir, "pair.db"));
    cat = new ProviderCatalog(reopened);
    expect(cat.listProviders()).toHaveLength(1);
    reopened.close();
  });

  it("K3: a stale-version reconcile write CAS-conflicts instead of corrupting state", () => {
    const { store } = makeCtx("k3");
    seedDiscovered(store, "pv");
    const cat = new ProviderCatalog(store);
    const entry = cat.getProvider("pv")!;
    // Simulate two writers holding the same version — the loser must fail.
    store.put("provider", String(entry.entry_id), { ...entry, display_name: "w1" }, Number(entry.version));
    expect(() =>
      store.put("provider", String(entry.entry_id), { ...entry, display_name: "w2" }, Number(entry.version)),
    ).toThrow(/FAIL_CLOSED_VERSION_CONFLICT/);
  });
});

/* ============ R1 — remediation test matrix (§13–§20) ======================
 *
 * §13  STALE = NOT CURRENT = NOT ROUTABLE (planner + DSH, zero invocation)
 * §14  provider REAPPEARED → observation only → re-validate/probe/qualify
 * §15  model REAPPEARED → observation only → fresh probe + qualify
 * §16  provider↔model linkage mismatch: binding fail-closed + projection
 * §17  Planner/DSH fail closed on linkage mismatch before any invocation
 * §18  legacy fingerprint-less receipt → MODEL_RECEIPT_CURRENT FAIL
 * §19  provider_id contradiction → MODEL_PROVIDER_IDENTITY_CONSISTENT FAIL
 * §20  authoritative source disappearance → bounded absence (no indefinite
 *      last-known-good); never-configured source is silent
 */

class TogglableSource {
  supported = true;
  constructor(
    readonly sourceId: string,
    private readonly ids: string[],
  ) {}
  supports(): boolean {
    return this.supported;
  }
  discover() {
    return this.ids.map((pid) => ({
      provider_native_id: pid,
      canonical_hint: pid,
      source_id: this.sourceId,
      display_name: pid,
      provider_type: "OPENAI_COMPATIBLE",
      protocol_family: "OPENAI_COMPATIBLE",
      provider_family: pid,
      credential_reference_name: `${pid.toUpperCase()}_KEY`,
    }));
  }
}

describe("R1 — §13 STALE non-routable", () => {
  it("STALE provider: eligibility fails, planner+DSH reject before invocation, projection non-routable", async () => {
    const { store, service } = makeCtx("r13");
    const env = { PV_KEY: "cred" };
    runProviderDiscovery(store, {
      context: { env },
      sources: [new CredentialEnvSource([{ provider_id: "pv", env_name: "PV_KEY" }])],
    });
    await mkQualifiedProvider(store, "pv");
    const mePlanner = mkModel(store, "pv", "mp");
    assignModelRole(store, mePlanner, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    const meDsh = mkModel(store, "pv", "md");
    assignModelRole(store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("r13j"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    });
    registerDsh(service, adapter);
    const b = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: meDsh,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(service, String(b.binding_id));
    const cand = { ref: "pv:md", pid: "pv", mid: "md", model_entry_id: meDsh };
    expect(() => assertPlannerCandidateEligible(store, mePlanner)).not.toThrow();
    expect(() => assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID)).not.toThrow();
    expect(projectRoutableModels(service)[0]!.routable).toBe(true);

    // One authoritative absence → STALE. STALE = NOT CURRENT: new work
    // cannot be authorized against it (history stays, authority gone).
    runProviderDiscovery(store, {
      context: { env },
      sources: [new CredentialEnvSource([])],
    });
    const p = new ProviderCatalog(store).getProvider("pv")!;
    expect(p.conditions).toContain("STALE");
    expect(p.conditions).not.toContain("REMOVED");
    expect(p.lifecycle_state).toBe("MODEL_DISCOVERY_ELIGIBLE"); // historical state kept
    const elig = providerModelEligibility(store, "pv", mePlanner);
    expect(elig.gates.PROVIDER_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    // Availability-channel rejection (failover-eligible, never an
    // authority grant): planner returns a structured rejection, DSH too —
    // both BEFORE any model invocation or dispatch.
    expect(assertPlannerCandidateEligible(store, mePlanner)).toMatchObject({ reject: true });
    const dshRej = assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID);
    expect(dshRej).toMatchObject({ reject: true });
    expect(projectRoutableModels(service)[0]!.routable).toBe(false);
    expect(projectRoutableModels(service)[0]!.gates.PROVIDER_CURRENT).toBe("FAIL");
  });
});

describe("R1 — §14 provider reappearance = observation only", () => {
  it("REMOVED→reappeared provider loses all runtime authority until re-qualified", async () => {
    const { store } = makeCtx("r14");
    const env = { PV_KEY: "cred" };
    const src = new CredentialEnvSource([{ provider_id: "pv", env_name: "PV_KEY" }]);
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const oldReceipt = String(new ProviderCatalog(store).getProvider("pv")!.current_qualification_receipt_id);
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [new CredentialEnvSource([])] });
    }
    const cat = new ProviderCatalog(store);
    expect(cat.getProvider("pv")!.conditions).toContain("REMOVED");

    // Re-observation: REAPPEARED + observation lifecycle restored, but
    // auth/probe authority reset — the historical receipt stays inspectable.
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    const p = cat.getProvider("pv")!;
    expect(p.conditions).toContain("REAPPEARED");
    expect(p.lifecycle_state).toBe("DISCOVERY_ELIGIBLE");
    expect(p.auth_state).toBe("AUTH_REQUIRED");
    expect(p.probe_state).toBe("UNPROBED");
    expect(Number(p.absence_streak)).toBe(0);
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_QUALIFIED).toBe("FAIL");
    expect(elig.gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    // Historical receipt row is inspectable — never silently deleted.
    expect(store.get("provider_qualification", oldReceipt).receipt_id).toBe(oldReceipt);

    // Normal re-proof chain restores authority with a NEW receipt.
    const v = new ProviderValidator(store);
    await v.validateAccess("pv", {
      env: { PV_KEY: "cred" },
      probe: async () => ({ outcome: "AUTH_OK", latency_ms: 3 }),
    });
    v.qualify("pv", { env: { PV_KEY: "cred" }, actor: "t" });
    const p2 = cat.getProvider("pv")!;
    expect(p2.lifecycle_state).toBe("MODEL_DISCOVERY_ELIGIBLE"); // qualified lifecycle
    expect(p2.current_qualification_receipt_id).not.toBe(oldReceipt);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R1 — §15 model reappearance = observation only", () => {
  it("REMOVED→reappeared model returns to DISCOVERED until fresh probe+qualify", async () => {
    const { store } = makeCtx("r15");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);

    // Three authoritative COMPLETE absences → REMOVED.
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      mcat.reconcileAbsence("pv", new Set(), { snapshotStatus: "COMPLETE", actor: "t" });
    }
    let m = mcat.getModel(me)!;
    expect(m.conditions).toContain("REMOVED");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(false);

    // Re-observation: REAPPEARED + lifecycle back to DISCOVERED — no
    // regained new-work authority from reappearance alone.
    mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    m = mcat.getModel(me)!;
    expect(m.conditions).toContain("REAPPEARED");
    expect(m.conditions).not.toContain("REMOVED");
    expect(m.lifecycle_state).toBe("DISCOVERED");
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_QUALIFIED).toBe("FAIL");
    expect(elig.eligible).toBe(false);

    // Fresh probe+qualification mints new/current authority → routable.
    mcat.recordProbeReceipt({
      probe_id: "PRB_r15_fresh",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(
      true,
    );
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R1 — §16/§17 provider↔model linkage", () => {
  it("mutation-time fail closed: binding P2→model-owned-by-P1 throws LINK_MISMATCH", async () => {
    const { store, service } = makeCtx("r16a");
    await mkQualifiedProvider(store, "p1");
    await mkQualifiedProvider(store, "p2");
    const me = mkModel(store, "p1", "m1");
    expect(() =>
      ensureBinding(service, {
        executor_id: DSH_EXECUTOR_ID,
        provider_id: "p2",
        model_entry_id: me,
        transport_compat: "OPENAI_COMPLETIONS",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH/);
    expect(listBindings(service)).toHaveLength(0);
  });

  it("injected legacy malformed binding: projection non-routable, qualify fail-closed", async () => {
    const { store, service } = makeCtx("r16b");
    await mkQualifiedProvider(store, "p1");
    await mkQualifiedProvider(store, "p2");
    const me = mkModel(store, "p1", "m1");
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("r16bj"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    });
    registerDsh(service, adapter);
    // Pre-R1 row shape (QUALIFIED state persisted, wrong provider link).
    store.put(
      "model_binding",
      "MBD_legacy",
      {
        binding_id: "MBD_legacy",
        executor_id: DSH_EXECUTOR_ID,
        provider_id: "p2",
        model_entry_id: me,
        transport_compat: "OPENAI_COMPLETIONS",
        qualification_state: "QUALIFIED",
        evidence_refs: [],
        first_seen_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
        binding_digest: "legacy",
        version: 0,
      },
      0,
    );
    const rows = projectRoutableModels(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routable).toBe(false);
    expect(rows[0]!.gates.MODEL_PROVIDER_MATCH).toBe("FAIL");
    expect(() => qualifyBinding(service, "MBD_legacy")).toThrow(
      /FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH/,
    );
    // Shared seam: the mismatched pair answers FAIL directly too.
    expect(providerModelEligibility(store, "p2", me).gates.MODEL_PROVIDER_MATCH).toBe("FAIL");
  });

  it("planner + DSH throw on linkage mismatch before any invocation", async () => {
    const { store, service } = makeCtx("r17");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    // Legacy/corrupt entry: no authoritative provider_id on the model.
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1", { provider_id: undefined }), "t");
    const me = String(entry.model_entry_id);
    mcat.recordProbeReceipt({
      probe_id: "PRB_r17",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(
      /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/,
    );
    const meDsh = mkModel(store, "pv", "m2", true);
    store.put(
      "model_entry",
      meDsh,
      { ...mcat.getModel(meDsh)!, provider_id: null },
      Number(mcat.getModel(meDsh)!.version),
    );
    assignModelRole(store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    expect(() =>
      assertDshCandidateEligible(
        service,
        { ref: "pv:m2", pid: "pv", mid: "m2", model_entry_id: meDsh },
        DSH_EXECUTOR_ID,
      ),
    ).toThrow(/FAIL_CLOSED/);
  });
});

describe("R1 — §18/§12 receipt binding", () => {
  it("legacy fingerprint-less receipt fails MODEL_RECEIPT_CURRENT; fresh qualify re-authorizes", async () => {
    const { store } = makeCtx("r18");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    // Inject a pre-R1 legacy receipt (no material_fingerprint) as current.
    store.put(
      "model_qualification",
      "MQR_legacy",
      {
        receipt_id: "MQR_legacy",
        model_entry_id: me,
        capability_scope: ["text_inference"],
        verifier: "legacy-verifier",
        evidence_refs: [],
        issued_at: "2025-01-01T00:00:00Z",
        version: 0,
      },
      0,
    );
    const body = mcat.getModel(me)!;
    store.put(
      "model_entry",
      me,
      { ...body, current_qualification_receipt_id: "MQR_legacy" },
      Number(body.version),
    );
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_RECEIPT_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);

    // Fresh probe+qualification mints a bound receipt → authority restored.
    mcat.recordProbeReceipt({
      probe_id: "PRB_r18_fresh",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(
      true,
    );
    const fresh = mcat.getModel(me)!;
    const receipt = store.get("model_qualification", String(fresh.current_qualification_receipt_id));
    expect(String(receipt.material_fingerprint)).toBe(modelIdentityDigest(fresh));
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });

  it("modelIdentityDigest binds provider_id — linkage change invalidates the fingerprint", async () => {
    const { store } = makeCtx("r12");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const d1 = modelIdentityDigest(entry);
    const d2 = modelIdentityDigest({ ...entry, provider_id: "other-provider" });
    expect(d1).not.toBe(d2);
    expect(String(entry.provider_id)).toBe("pv");
  });
});

describe("R1 — §19 provider_id contradiction", () => {
  it("unresolved provider_id contradiction fails MODEL_PROVIDER_IDENTITY_CONSISTENT", async () => {
    const { store } = makeCtx("r19");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1"); // QUALIFIED, provider_id=pv
    // Second claim: same family+model identity, DIFFERENT provider_id.
    mcat.upsertModelClaim(CLAIM("pv", "m1", { provider_id: "p2" }), "t");
    const m = mcat.getModel(me)!;
    expect(String(m.provider_id)).toBe("pv"); // first link never flips
    expect(
      (m.contradictions as Array<{ field?: string }>).some((c) => c.field === "provider_id"),
    ).toBe(true);
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_PROVIDER_IDENTITY_CONSISTENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    // Planner treats it as an authority violation — fail closed.
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(
      /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/,
    );
  });
});

describe("R1 — §20 source disappearance", () => {
  it("previously-active source supports()=false → ABSENT observation → bounded streak → REMOVED", async () => {
    const { store } = makeCtx("r20a");
    const env = { PV_KEY: "cred" };
    const src = new TogglableSource("SRC_A", ["pv"]);
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);

    src.supported = false; // authoritative source definitively disappears
    runProviderDiscovery(store, { context: { env }, sources: [src] });
    const snaps = (store.list("provider_snapshot") as Record<string, unknown>[]).filter(
      (s) => s.source_id === "SRC_A",
    );
    expect(snaps.some((s) => s.status === "ABSENT")).toBe(true);
    const p1 = new ProviderCatalog(store).getProvider("pv")!;
    expect(p1.conditions).toContain("STALE");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(false);

    // Bounded — no indefinite last-known-good: hits REMOVED at threshold.
    for (let i = 1; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [src] });
    }
    expect(new ProviderCatalog(store).getProvider("pv")!.conditions).toContain("REMOVED");
  });

  it("never-configured source (no prior snapshot) supports()=false → silent skip, nothing demoted", async () => {
    const { store } = makeCtx("r20b");
    const env = { PV_KEY: "cred", PV2_KEY: "cred" };
    const srcB = new TogglableSource("SRC_B", ["pv2"]);
    runProviderDiscovery(store, { context: { env }, sources: [srcB] });
    const never = new TogglableSource("SRC_NEVER", []);
    never.supported = false;
    const res = runProviderDiscovery(store, { context: { env }, sources: [srcB, never] });
    // No ABSENT snapshot, no claim — never observed, so no authority loss.
    expect(
      (store.list("provider_snapshot") as Record<string, unknown>[]).some(
        (s) => s.source_id === "SRC_NEVER",
      ),
    ).toBe(false);
    const p = new ProviderCatalog(store).getProvider("pv2")!;
    expect(p.conditions ?? []).not.toContain("STALE");
    expect(res.stale).toHaveLength(0);
  });
});

/* ================= R2 — fresh evidence + route identity closure ========== */

describe("R2 — §12/§13 historical probe cannot requalify; fresh probe restores", () => {
  it("STALE→REMOVED→REAPPEARED model: qualifyModel fails closed on no current probe, fresh probe requalifies", async () => {
    const { store } = makeCtx("r2a");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    const oldProbe = (mcat.getModel(me)!.probe_receipt_ids as string[])[0];
    expect(store.get("probe_receipt", oldProbe).result).toBe("PASS");

    // STALE→REMOVED by authoritative absence → reappearance resets the
    // current evidence epoch: probe window empty, receipt pointer cleared,
    // observation only restored.
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      mcat.reconcileAbsence("pv", new Set(), { snapshotStatus: "COMPLETE", actor: "t" });
    }
    mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const m = mcat.getModel(me)!;
    expect(m.conditions).toContain("REAPPEARED");
    expect(m.lifecycle_state).toBe("DISCOVERED");
    expect(m.probe_state).toBe("UNPROBED");
    expect(m.last_probe_at).toBeNull();
    expect(m.current_qualification_receipt_id).toBeNull();
    expect(m.probe_receipt_ids).toEqual([]);

    // §12 — historical probe evidence is NOT current authority: no new
    // qualification minted, but the old probe_receipt entity stays
    // persisted and inspectable.
    const q = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(false);
    expect(q.gates.CURRENT_PROBE_EVIDENCE).toBe("FAIL");
    expect(q.gates.CAPABILITY_TEXT_INFERENCE).toBe("FAIL");
    expect(store.get("probe_receipt", oldProbe).probe_id).toBe(oldProbe);
    expect(mcat.listProbeReceipts(me).map((r) => r.probe_id)).toContain(oldProbe);
    expect(mcat.getModel(me)!.current_qualification_receipt_id).toBeNull();
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(false);

    // §13 — a fresh canonical probe in the new epoch restores authority;
    // the minted receipt references only the fresh probe id.
    mcat.recordProbeReceipt({
      probe_id: "PRB_r2_fresh",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 2,
    });
    const q2 = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q2.qualified).toBe(true);
    const refs = q2.receipt!.evidence_refs as string[];
    expect(refs).toContain("PRB_r2_fresh");
    expect(refs).not.toContain(oldProbe);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R2 — §14 direct receipt bypass closed", () => {
  it("issueQualificationReceipt rejects missing capability coverage and foreign/historical evidence refs", () => {
    const { store } = makeCtx("r2b");
    const mcat = new ModelEvidenceCatalog(store);
    // DISCOVERED + UNPROBED model: arbitrary evidence_refs cannot mint
    // QUALIFIED authority.
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);
    expect(() =>
      mcat.issueQualificationReceipt(me, {
        capability_scope: ["text_inference"],
        verifier: "attacker-fixture",
        evidence_refs: ["fresh"],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING/);

    // A real probe receipt owned by ANOTHER model is foreign evidence here.
    const other = mkModel(store, "pv", "m2");
    const foreignId = (mcat.getModel(other)!.probe_receipt_ids as string[])[0];
    mcat.recordProbeReceipt({
      probe_id: "PRB_mine",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(() =>
      mcat.issueQualificationReceipt(me, {
        capability_scope: ["text_inference"],
        verifier: "attacker-fixture",
        evidence_refs: ["PRB_mine", foreignId],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_FOREIGN/);
    expect(mcat.getModel(me)!.lifecycle_state).toBe("PROBED"); // still not QUALIFIED
    expect(mcat.getModel(me)!.current_qualification_receipt_id).toBeNull();
  });
});

describe("R2 — §15/§16 provider reappearance: no boolean bypass, fresh probe restores", () => {
  it("reappeared provider (DISCOVERY_ELIGIBLE/AUTH_OK-resolvable/UNPROBED) fails PROTOCOL_PROBED until a real probe", async () => {
    const { store } = makeCtx("r2c");
    const env = { PV_KEY: "cred" };
    const srcA = new TogglableSource("SRC_A", ["pv"]);
    const cat = new ProviderCatalog(store);
    runProviderDiscovery(store, { context: { env }, sources: [srcA] });
    await mkQualifiedProvider(store, "pv");
    const oldReceipt = String(cat.getProvider("pv")!.current_qualification_receipt_id);

    // Authoritative absence → STALE→REMOVED, then reappearance resets the
    // probe epoch and clears the current receipt pointer (row preserved).
    const srcEmpty = new TogglableSource("SRC_A", []);
    for (let i = 0; i < PROVIDER_REMOVED_ABSENCE_THRESHOLD; i++) {
      runProviderDiscovery(store, { context: { env }, sources: [srcEmpty] });
    }
    runProviderDiscovery(store, { context: { env }, sources: [srcA] });
    const p = cat.getProvider("pv")!;
    expect(p.conditions).toContain("REAPPEARED");
    expect(p.lifecycle_state).toBe("DISCOVERY_ELIGIBLE");
    expect(p.probe_state).toBe("UNPROBED");
    expect(p.current_qualification_receipt_id).toBeNull();

    // §15 — a caller-provided boolean is gone from the API: durable
    // probe_state is the only PROTOCOL_PROBED authority. Credential is
    // resolvable (AUTH_ACCEPTABLE would pass) yet qualification still
    // fails on the probe gate; no receipt is minted.
    const v = new ProviderValidator(store);
    const q = v.qualify("pv", { env });
    expect(q.qualified).toBe(false);
    expect(q.gates.AUTH_ACCEPTABLE).toBe("PASS");
    expect(q.gates.PROTOCOL_PROBED).toBe("FAIL");
    expect(q.receipt).toBeUndefined();
    expect(cat.getProvider("pv")!.current_qualification_receipt_id).toBeNull();

    // §16 — fresh canonical probe → qualification installs a NEW current
    // receipt; the old row stays inspectable.
    await v.validateAccess("pv", {
      env,
      probe: async () => ({ outcome: "AUTH_OK", latency_ms: 4 }),
    });
    expect(cat.getProvider("pv")!.probe_state).toBe("PROBED");
    const q2 = v.qualify("pv", { env });
    expect(q2.qualified).toBe(true);
    const p2 = cat.getProvider("pv")!;
    expect(String(p2.current_qualification_receipt_id)).not.toBe(oldReceipt);
    expect(store.get("provider_qualification", oldReceipt).receipt_id).toBe(oldReceipt);
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R2 — §17/§18 configured route must prove provider ownership", () => {
  it("planner route P2:M resolving to provider_id P1 fails closed with zero mutation", async () => {
    const { store } = makeCtx("r2d");
    const mcat = new ModelEvidenceCatalog(store);
    // Malformed/legacy entry: family alias P2 but canonical owner P1.
    const { entry } = mcat.upsertModelClaim(
      CLAIM("p2", "m", { provider_id: "p1", provider_family: "p2" }),
      "t",
    );
    expect(String(entry.provider_id)).toBe("p1");
    const rolesBefore = store.list("model_role").length;
    expect(() =>
      resolveConfiguredModelRoleRoute(
        (p, m) => mcat.getModelByIds(p, m),
        { route: "p2:m", role: MODEL_ROLE.PLANNER_COORDINATOR },
      ),
    ).toThrow(/FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH/);
    // ZERO role mutation — resolution failed before any role/binding work.
    expect(store.list("model_role")).toHaveLength(rolesBefore);
  });

  it("DSH route P2:M uses the same ownership rule (before pool construction)", async () => {
    const { store } = makeCtx("r2e");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(
      CLAIM("p2", "m", { provider_id: "p1", provider_family: "p2" }),
      "t",
    );
    expect(String(entry.provider_id)).toBe("p1");
    const rolesBefore = store.list("model_role").length;
    expect(() =>
      resolveConfiguredModelRoleRoute(
        (p, m) => mcat.getModelByIds(p, m),
        { route: "p2:m", role: MODEL_ROLE.DSH_EXECUTION },
      ),
    ).toThrow(/FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH/);
    expect(store.list("model_role")).toHaveLength(rolesBefore);
  });
});

describe("R2 — §19 provider routable gates agree on STALE", () => {
  it("STALE provider: PROVIDER_CURRENT FAIL and providerRoutableGate.pass=false", async () => {
    const { store } = makeCtx("r2f");
    const env = { PV_KEY: "cred" };
    const srcA = new TogglableSource("SRC_A", ["pv"]);
    runProviderDiscovery(store, { context: { env }, sources: [srcA] });
    await mkQualifiedProvider(store, "pv");
    const me = mkModel(store, "pv", "m1");
    const srcEmpty = new TogglableSource("SRC_A", []);
    runProviderDiscovery(store, { context: { env }, sources: [srcEmpty] });
    const p = new ProviderCatalog(store).getProvider("pv")!;
    expect(p.conditions).toContain("STALE");
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    expect(providerRoutableGate(p).pass).toBe(false);
  });
});

/* ==================== R3 — CURRENT PROBE CLOSURE ====================
 * R3 §1–§3 — a newer canonical probe failure revokes model invocation
 * immediately: MODEL_PROBE_CURRENT exact-PROBED in shared eligibility,
 * availability-classified (planner/DSH reject, never authority grant).
 * R3 §5–§7 — the provider qualification commit seam validates durable
 * state itself. R3 §10/§11 — window ownership + derived evidence_refs. */

describe("R3 — §8/§9 provider seam: forged receipt fails closed, canonical probe restores", () => {
  it("AUTH_OK + UNPROBED + all-PASS forged gates → no receipt, not routable; real probe → qualify restores", async () => {
    const { store } = makeCtx("r3p");
    seedDiscovered(store, "pv");
    const cat = new ProviderCatalog(store);
    const e = cat.getProvider("pv")!;
    store.put("provider", String(e.entry_id), {
      ...e,
      auth_state: "AUTH_OK",
      probe_state: "UNPROBED",
      lifecycle_state: "DISCOVERY_ELIGIBLE",
    }, Number(e.version));

    // Forged commit attempt: the seam validates durable canonical state
    // (and R5 recomputes gate values itself — no caller map exists).
    expect(() =>
      cat.issueQualificationReceipt("pv", {
        policy_version: "t",
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_STATE/);
    const p = cat.getProvider("pv")!;
    expect(p.current_qualification_receipt_id ?? null).toBeNull();
    expect(p.lifecycle_state).toBe("DISCOVERY_ELIGIBLE");
    expect(providerRoutableGate(p).pass).toBe(false);
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).gates.PROVIDER_PROBE_CURRENT).toBe("FAIL");

    // A denied-policy provider on canonical PROBED+AUTH_OK state is
    // rejected by the derived decision — no caller gate map exists to
    // forge.
    await new ProviderValidator(store).validateAccess("pv", {
      env: { PV_KEY: "cred" },
      probe: async () => ({ outcome: "AUTH_OK", latency_ms: 3 }),
    });
    expect(cat.getProvider("pv")!.probe_state).toBe("PROBED");
    expect(() =>
      cat.issueQualificationReceipt("pv", {
        policy_version: "t",
        policyDenyList: ["pv"],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);

    // §9 — canonical path: qualify() mints over the durable PROBED state.
    const q = new ProviderValidator(store).qualify("pv", { env: { PV_KEY: "cred" } });
    expect(q.qualified).toBe(true);
    expect(q.receipt).toBeTruthy();
    expect(cat.getProvider("pv")!.probe_state).toBe("PROBED");
    expect(providerModelEligibility(store, "pv", me).gates.PROVIDER_PROBE_CURRENT).toBe("PASS");
  });
});

describe("R3 — §12 model probe failure revokes invocation", () => {
  it("qualified routable model + new FAIL probe → PROBE_FAIL, MODEL_PROBE_CURRENT FAIL, planner+DSH reject, old PASS inspectable", async () => {
    const { store, service } = makeCtx("r12");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const mePlanner = mkModel(store, "pv", "mp");
    assignModelRole(store, mePlanner, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    const meDsh = mkModel(store, "pv", "md");
    assignModelRole(store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    registerDsh(service, new DshExecutorAdapter({
      journalRoot: path.join(freshDir("r12j"), "j"),
      envReader: () => "cred",
      compatEnvRouteFallback: true,
      launchOverride: { command: "node", args: ["fixture.mjs", "--profile", "acp"] },
    }));
    const bind = ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pv",
      model_entry_id: meDsh,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(service, String(bind.binding_id));
    const passProbe = String(mcat.getModel(mePlanner)!.probe_receipt_ids![0]);
    expect(assertPlannerCandidateEligible(store, mePlanner)).toBeUndefined();
    const cand = { ref: "pv:md", pid: "pv", mid: "md", model_entry_id: meDsh };
    expect(assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID)).toBeUndefined();

    // New canonical probe FAILS — durable failure evidence. ZERO new
    // invocation is authorized from this point (planner, DSH, projection).
    mcat.recordProbeReceipt({
      probe_id: "PRB_r12_fail",
      model_entry_id: mePlanner,
      provider_id: "pv",
      result: "FAIL",
      probe_type: "text_inference",
      latency_ms: 4,
    });
    mcat.recordProbeReceipt({
      probe_id: "PRB_r12_fail_d",
      model_entry_id: meDsh,
      provider_id: "pv",
      result: "FAIL",
      probe_type: "text_inference",
      latency_ms: 4,
    });
    expect(mcat.getModel(mePlanner)!.probe_state).toBe("PROBE_FAIL");
    const elig = providerModelEligibility(store, "pv", mePlanner);
    expect(elig.gates.MODEL_PROBE_CURRENT).toBe("FAIL");
    expect(elig.gates.MODEL_QUALIFIED).toBe("PASS"); // receipt/history kept
    expect(elig.eligible).toBe(false);
    // Availability-channel rejection before any invocation — never an
    // authority throw that mints failover authority.
    expect(assertPlannerCandidateEligible(store, mePlanner)).toMatchObject({ reject: true });
    expect(assertDshCandidateEligible(service, cand, DSH_EXECUTOR_ID)).toMatchObject({ reject: true });
    const projection = projectRoutableModels(service);
    expect(projection.length).toBeGreaterThan(0);
    expect(projection.every((r) => !r.routable)).toBe(true);
    // Historical PASS probe stays persisted and inspectable.
    expect(mcat.listProbeReceipts(mePlanner).map((r) => r.probe_id)).toContain(passProbe);
    expect(mcat.getModel(mePlanner)!.current_qualification_receipt_id).toBeTruthy();
  });
});

describe("R3 — §13 fresh PASS probe restores model invocation", () => {
  it("PROBE_FAIL model + fresh PASS → PROBED → qualifyModel → receipt refs current PASS, routable", async () => {
    const { store } = makeCtx("r13m");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    mcat.recordProbeReceipt({ probe_id: "PRB_r13_fail", model_entry_id: me, provider_id: "pv", result: "FAIL", probe_type: "text_inference", latency_ms: 1 });
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_PROBE_CURRENT).toBe("FAIL");

    mcat.recordProbeReceipt({
      probe_id: "PRB_r13_pass",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(mcat.getModel(me)!.probe_state).toBe("PROBED");
    const q = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(true);
    const refs = q.receipt!.evidence_refs as string[];
    // R4 §10 — refs carry only the LATEST covering receipt per capability;
    // the superseded PASS and the FAIL receipt are never evidence.
    expect(refs).toEqual(["PRB_r13_pass"]);
    expect(refs).not.toContain("PRB_r13_fail");
    // The minted receipt's refs are valid CURRENT window probe ids.
    const window = new Set(mcat.getModel(me)!.probe_receipt_ids as string[]);
    expect(refs.every((r) => window.has(r))).toBe(true);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R3 — §14 older PASS never overrides latest FAIL", () => {
  it("epoch [PASS, FAIL]: qualifyModel refuses even though a PASS receipt sits in the current window", async () => {
    const { store } = makeCtx("r14");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);
    mcat.recordProbeReceipt({
      probe_id: "PRB_r14_pass",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    mcat.recordProbeReceipt({
      probe_id: "PRB_r14_fail",
      model_entry_id: me,
      provider_id: "pv",
      result: "FAIL",
      probe_type: "text_inference",
      latency_ms: 1,
    });
    // Window holds [PASS, FAIL]; probe_state reflects the latest = PROBE_FAIL.
    expect(mcat.getModel(me)!.probe_receipt_ids).toEqual(["PRB_r14_pass", "PRB_r14_fail"]);
    expect(mcat.getModel(me)!.probe_state).toBe("PROBE_FAIL");
    const q = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(false);
    expect(q.gates.CURRENT_PROBE_EVIDENCE).toBe("FAIL");
    // R4 §7 — latest-per-capability: the superseded PASS cannot cover
    // text_inference once a newer FAIL is the latest applicable receipt.
    expect(q.gates.CAPABILITY_TEXT_INFERENCE).toBe("FAIL");
    // The raw seam agrees: no current covering evidence, no receipt.
    expect(() =>
      mcat.issueQualificationReceipt(me, {
        capability_scope: ["text_inference"],
        verifier: "attacker-fixture",
        evidence_refs: ["PRB_r14_pass"],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING/);
    expect(mcat.getModel(me)!.current_qualification_receipt_id).toBeNull();
  });
});

describe("R3 — §15 foreign window membership yields no evidence", () => {
  it("injecting model B's probe id into A's window: currentProbeReceipts excludes it, qualification fails", async () => {
    const { store } = makeCtx("r15");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const a = String(mcat.upsertModelClaim(CLAIM("pv", "ma"), "t").entry.model_entry_id);
    const b = mkModel(store, "pv", "mb");
    const bProbe = String(mcat.getModel(b)!.probe_receipt_ids![0]);
    // Corrupt/legacy window: A references B's receipt id.
    const ea = mcat.getModel(a)!;
    store.put("model_entry", a, { ...ea, probe_receipt_ids: [bProbe] }, Number(ea.version));
    expect(mcat.currentProbeReceipts(a)).toEqual([]);
    const q = qualifyModel(store, a, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(false);
    expect(q.gates.CAPABILITY_TEXT_INFERENCE).toBe("FAIL");
    expect(() =>
      mcat.issueQualificationReceipt(a, {
        capability_scope: ["text_inference"],
        verifier: "t",
        evidence_refs: [bProbe],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING/);
    expect(mcat.getModel(a)!.current_qualification_receipt_id).toBeNull();
  });
});

describe("R3 — §16 minted refs derive from covering current PASS evidence", () => {
  it("caller evidence_refs=[] still mints a receipt whose refs are the actual covering PASS probes", async () => {
    const { store } = makeCtx("r16");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    const passProbe = String(mcat.getModel(me)!.probe_receipt_ids![0]);
    const receipt = mcat.issueQualificationReceipt(me, {
      capability_scope: ["text_inference"],
      verifier: "t",
      evidence_refs: [],
      actor: "t",
    });
    expect(receipt.evidence_refs).toEqual([passProbe]);
    expect((receipt.evidence_refs as string[]).length).toBeGreaterThan(0);
  });
});

/* ==================== R4 — CAPABILITY-SCOPED CURRENT EVIDENCE =========
 * R4 §1–§4 — the provider commit seam requires the full canonical gate
 * set. R4 §5–§10 — evidence is LATEST-PER-CAPABILITY inside the current
 * window; a PASS for capability B never revives capability A.
 * R4 §11–§13 — strict provider ownership at record + projection. */

describe("R4/R5 — provider qualification decision integrity (§4, §8, §9, §18)", () => {
  it("the commit seam derives canonical gates — denylist/DOWN forge-proof; DISABLED mints technically but stays non-routable", async () => {
    const { store } = makeCtx("r4p");
    const cat = new ProviderCatalog(store);
    // Canonical healthy state first (probe through the real validator).
    seedDiscovered(store, "pv");
    await new ProviderValidator(store).validateAccess("pv", {
      env: { PV_KEY: "cred" },
      probe: async () => ({ outcome: "AUTH_OK", latency_ms: 2 }),
    });
    expect(cat.getProvider("pv")!.probe_state).toBe("PROBED");

    // R5 §8 — POLICY_PERMITS is derived, not caller-supplied: a denied
    // provider can never mint, on either seam.
    expect(() =>
      cat.issueQualificationReceipt("pv", { policy_version: "t", policyDenyList: ["pv"], actor: "t" }),
    ).toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);
    expect(new ProviderValidator(store).qualify("pv", { env: { PV_KEY: "cred" }, policyDenyList: ["pv"] }).qualified).toBe(false);
    // A raw caller trying to smuggle a forged gates map gets nothing —
    // the seam's signature consumes no caller gate values at all.
    expect(() =>
      cat.issueQualificationReceipt("pv", {
        policy_version: "t",
        policyDenyList: ["pv"],
        gates: Object.fromEntries(PROVIDER_QUALIFICATION_REQUIRED_GATES.map((g) => [g, "PASS"])),
        actor: "t",
      } as never),
    ).toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);
    expect(cat.getProvider("pv")!.current_qualification_receipt_id ?? null).toBeNull();

    // R5 §9 — HEALTH_ACCEPTABLE likewise: a DOWN provider cannot mint
    // even with an otherwise healthy AUTH_OK/PROBED row.
    const down = cat.getProvider("pv")!;
    store.put("provider", String(down.entry_id), { ...down, health_state: "DOWN" }, Number(down.version));
    expect(() => cat.issueQualificationReceipt("pv", { policy_version: "t", actor: "t" }))
      .toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);
    expect(new ProviderValidator(store).qualify("pv", { env: { PV_KEY: "cred" } }).gates.HEALTH_ACCEPTABLE).toBe("FAIL");
    const back = cat.getProvider("pv")!;
    store.put("provider", String(back.entry_id), { ...back, health_state: "HEALTHY" }, Number(back.version));

    // §18 — DISABLED is operator authority: canonical qualification may
    // technically succeed, but DISABLED stays and routability stays closed.
    const e = cat.getProvider("pv")!;
    store.put("provider", String(e.entry_id), { ...e, conditions: ["DISABLED"] }, Number(e.version));
    const receipt = cat.issueQualificationReceipt("pv", { policy_version: "t", actor: "t" });
    expect(receipt.receipt_id).toBeTruthy();
    const after = cat.getProvider("pv")!;
    expect(after.conditions).toContain("DISABLED");
    expect(providerRoutableGate(after).pass).toBe(false);
  });
});

describe("R4 — §14 cross-capability: later unrelated PASS cannot revive a failed capability", () => {
  it("text PASS→qualify→routable; text FAIL→blocked; vision PASS→text still non-current, planner rejects", async () => {
    const { store } = makeCtx("r4x");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const me = mkModel(store, "pv", "m1");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(assertPlannerCandidateEligible(store, me)).toBeUndefined();

    const probe = (id: string, type: string, result: string) =>
      mcat.recordProbeReceipt({
        probe_id: id,
        model_entry_id: me,
        provider_id: "pv",
        result,
        probe_type: type,
        capability_evidence: { [type]: result },
        latency_ms: 1,
      });
    // Latest text evidence becomes FAIL.
    probe("PRB_x_text_fail", "text_inference", "FAIL");
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_CAPABILITY_PROBE_CURRENT).toBe("FAIL");
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({ reject: true });

    // A PASS for vision does NOT revive text_inference.
    probe("PRB_x_vision_pass", "vision", "PASS");
    expect(mcat.getModel(me)!.probe_state).toBe("PROBED"); // global summary only
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_CAPABILITY_PROBE_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    const q = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(false);
    expect(q.gates.CAPABILITY_TEXT_INFERENCE).toBe("FAIL");
    expect(q.gates.CURRENT_PROBE_EVIDENCE).toBe("FAIL");
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({ reject: true });
  });
});

describe("R4 — §15 multi-capability qualification: one failing capability fails all", () => {
  it("[text,tools] qualified → tools FAIL → unusable; fresh tools PASS → re-established", async () => {
    const { store } = makeCtx("r4m");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);
    const probe = (id: string, type: string, result: string) =>
      mcat.recordProbeReceipt({
        probe_id: id,
        model_entry_id: me,
        provider_id: "pv",
        result,
        probe_type: type,
        capability_evidence: { [type]: result },
        latency_ms: 1,
      });
    probe("PRB_m_text", "text_inference", "PASS");
    probe("PRB_m_tools", "tools", "PASS");
    const q1 = qualifyModel(store, me, { capability_scope: ["text_inference", "tools"], actor: "t" });
    expect(q1.qualified).toBe(true);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);

    probe("PRB_m_tools_fail", "tools", "FAIL");
    // The receipt scope [text,tools] no longer has current evidence for tools.
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_CAPABILITY_PROBE_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    expect(qualifyModel(store, me, { capability_scope: ["text_inference", "tools"], actor: "t" }).qualified).toBe(false);

    probe("PRB_m_tools_pass2", "tools", "PASS");
    const q2 = qualifyModel(store, me, { capability_scope: ["text_inference", "tools"], actor: "t" });
    expect(q2.qualified).toBe(true);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R4 — §16 superseded PASS receipts cannot authorize", () => {
  it("[text PASS#1, text PASS#2] → receipt refs current covering #2 only; after FAIL#3 none authorize", async () => {
    const { store } = makeCtx("r4s");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);
    const probe = (id: string, result: string) =>
      mcat.recordProbeReceipt({
        probe_id: id,
        model_entry_id: me,
        provider_id: "pv",
        result,
        probe_type: "text_inference",
        capability_evidence: { text_inference: result },
        latency_ms: 1,
      });
    probe("PRB_s_1", "PASS");
    probe("PRB_s_2", "PASS");
    const q = qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" });
    expect(q.qualified).toBe(true);
    expect(q.receipt!.evidence_refs).toEqual(["PRB_s_2"]);

    probe("PRB_s_3", "FAIL");
    expect(mcat.listProbeReceipts(me).map((r) => r.probe_id)).toEqual(["PRB_s_1", "PRB_s_2", "PRB_s_3"]);
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(false);
    expect(providerModelEligibility(store, "pv", me).gates.MODEL_CAPABILITY_PROBE_CURRENT).toBe("FAIL");
  });
});

describe("R4 — §17/§18 strict provider ownership of probe evidence", () => {
  it("provider_id=null receipt recorded but never current; wrong-provider fails at record + projection", async () => {
    const { store } = makeCtx("r4o");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);

    // §17 — legacy-style receipt without provider_id lands in the window
    // (recording permits provider-less rows) but is never current
    // provider-bound evidence.
    mcat.recordProbeReceipt({
      probe_id: "PRB_o_null",
      model_entry_id: me,
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(mcat.getModel(me)!.probe_receipt_ids).toContain("PRB_o_null");
    expect(mcat.currentProbeReceipts(me)).toEqual([]);
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(false);
    // Never qualified → the capability gate is N/A-PASS; routability stays
    // closed through MODEL_QUALIFIED.
    const elig0 = providerModelEligibility(store, "pv", me);
    expect(elig0.eligible).toBe(false);
    expect(elig0.gates.MODEL_QUALIFIED).toBe("FAIL");

    // §18a — wrong provider_id fails closed AT RECORDING.
    expect(() =>
      mcat.recordProbeReceipt({
        probe_id: "PRB_o_wrong",
        model_entry_id: me,
        provider_id: "other-provider",
        result: "PASS",
        probe_type: "text_inference",
        capability_evidence: { text_inference: "PASS" },
        latency_ms: 1,
      }),
    ).toThrow(/FAIL_CLOSED_PROBE_PROVIDER_MISMATCH/);

    // §18b — a wrong-provider row injected around the recording boundary
    // (corrupt/legacy DB row + window pointer) is still excluded at
    // projection: no qualification authority.
    const corrupt = {
      probe_id: "PRB_o_corrupt",
      model_entry_id: me,
      provider_id: "other-provider",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    };
    store.put("probe_receipt", "PRB_o_corrupt", corrupt);
    const cur = mcat.getModel(me)!;
    store.put("model_entry", me, { ...cur, probe_receipt_ids: [...(cur.probe_receipt_ids as string[]), "PRB_o_corrupt"] }, Number(cur.version));
    expect(mcat.currentProbeReceipts(me).map((r) => r.probe_id)).not.toContain("PRB_o_corrupt");
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(false);

    // §17 end — a fresh provider-bound probe through the canonical path
    // restores qualification.
    mcat.recordProbeReceipt({
      probe_id: "PRB_o_bound",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(true);
  });
});

/* ==================== R5 — EMPTY-SCOPE + DECISION INTEGRITY ==========
 * R5 §1–§4 — capability_scope must be canonically non-empty; legacy
 * empty-scope receipts are historical only, never routable.
 * R5 §5–§12 — provider gate values are canonical output; runtime
 * receipt validation re-checks the required gate set. */

describe("R5 — §13 canonical capability scope contract", () => {
  it("empty/blank scopes fail closed at qualifyModel AND the commit seam", async () => {
    const { store } = makeCtx("r5s");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);

    // A: qualifyModel with [] — canonical scope error, no receipt, no QUALIFIED.
    expect(() => qualifyModel(store, me, { capability_scope: [], actor: "t" }))
      .toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE/);
    expect(mcat.getModel(me)!.current_qualification_receipt_id ?? null).toBeNull();
    expect(mcat.getModel(me)!.lifecycle_state).not.toBe("QUALIFIED");

    // B: direct seam — same fail closed (no diagnostic-path bypass).
    expect(() =>
      mcat.issueQualificationReceipt(me, {
        capability_scope: [],
        verifier: "t",
        evidence_refs: [],
        actor: "t",
      }),
    ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE/);

    // C: blank / whitespace-only identifiers — same.
    for (const bad of [[""], ["   "], ["\t\n"]]) {
      expect(() => qualifyModel(store, me, { capability_scope: bad, actor: "t" }))
        .toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE/);
      expect(() =>
        mcat.issueQualificationReceipt(me, {
          capability_scope: bad,
          verifier: "t",
          evidence_refs: [],
          actor: "t",
        }),
      ).toThrow(/FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE/);
    }
    expect(mcat.listModels("pv").every((m) => m.lifecycle_state !== "QUALIFIED")).toBe(true);

    // §15 control — normal path still works: fresh PASS probe then a
    // canonical (trimmed/deduped) scope qualifies.
    mcat.recordProbeReceipt({
      probe_id: "PRB_r5_text",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    const q = qualifyModel(store, me, { capability_scope: [" text_inference ", "text_inference"], actor: "t" });
    expect(q.qualified).toBe(true);
    expect(q.receipt!.capability_scope).toEqual(["text_inference"]);
    expect((q.receipt!.evidence_refs as string[]).length).toBeGreaterThan(0);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R5 — §14 legacy empty-scope receipt is not current authority", () => {
  it("QUALIFIED model + receipt capability_scope=[] → MODEL_QUALIFICATION_SCOPE_VALID FAIL, non-routable, planner rejects", async () => {
    const { store } = makeCtx("r5l");
    await mkQualifiedProvider(store, "pv");
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim(CLAIM("pv", "m1"), "t");
    const me = String(entry.model_entry_id);
    // Inject a legacy/corrupt qualified state: lifecycle QUALIFIED with a
    // fingerprint-valid receipt whose scope is empty — minted before the
    // safe commit seam existed.
    const legacy = {
      receipt_id: "MQR_legacy_empty",
      model_entry_id: me,
      capability_scope: [],
      verifier: "legacy",
      evidence_refs: [],
      material_fingerprint: modelIdentityDigest(mcat.getModel(me)!),
      issued_at: "2026-01-01T00:00:00Z",
    };
    store.put("model_qualification", legacy.receipt_id, legacy);
    const cur = mcat.getModel(me)!;
    store.put("model_entry", me, {
      ...cur,
      lifecycle_state: "QUALIFIED",
      probe_state: "PROBED",
      current_qualification_receipt_id: legacy.receipt_id,
    }, Number(cur.version));
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });

    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.MODEL_QUALIFICATION_SCOPE_VALID).toBe("FAIL");
    expect(elig.eligible).toBe(false);
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({ reject: true });
    // Canonical requalification still works — fresh probe + valid scope.
    mcat.recordProbeReceipt({
      probe_id: "PRB_r5_fix",
      model_entry_id: me,
      provider_id: "pv",
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    expect(qualifyModel(store, me, { capability_scope: ["text_inference"], actor: "t" }).qualified).toBe(true);
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);
  });
});

describe("R5 — §8/§9 no public seam can forge POLICY_PERMITS or HEALTH_ACCEPTABLE", () => {
  it("denylisted provider: qualify + raw seam both refuse; not routable", async () => {
    const { store } = makeCtx("r5d");
    await mkQualifiedProvider(store, "pv");
    const cat = new ProviderCatalog(store);
    const me = mkModel(store, "pv", "m1");
    expect(providerModelEligibility(store, "pv", me).eligible).toBe(true);

    // Fresh qualification attempt under a denylist — both seams refuse.
    expect(new ProviderValidator(store).qualify("pv", { env: { PV_KEY: "cred" }, policyDenyList: ["pv"] }).qualified).toBe(false);
    expect(() =>
      cat.issueQualificationReceipt("pv", { policy_version: "t", policyDenyList: ["pv"], actor: "t" }),
    ).toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);
    // Existing authority from the healthy epoch persists (receipt kept —
    // policy denial is a new-decision state, not a receipt rewrite).
    expect(cat.getProvider("pv")!.current_qualification_receipt_id).toBeTruthy();
  });

  it("DOWN provider: qualify + raw seam both refuse", async () => {
    const { store } = makeCtx("r5h");
    await mkQualifiedProvider(store, "pv");
    const cat = new ProviderCatalog(store);
    const p = cat.getProvider("pv")!;
    store.put("provider", String(p.entry_id), { ...p, health_state: "DOWN" }, Number(p.version));
    expect(new ProviderValidator(store).qualify("pv", { env: { PV_KEY: "cred" } }).gates.HEALTH_ACCEPTABLE).toBe("FAIL");
    expect(() => cat.issueQualificationReceipt("pv", { policy_version: "t", actor: "t" }))
      .toThrow(/FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES/);
  });
});

describe("R5 — §11/§12 provider receipt runtime gate validation", () => {
  const seedQualified = async (store: PairEvidenceStore) => {
    await mkQualifiedProvider(store, "pv");
    const cat = new ProviderCatalog(store);
    return { cat, p: cat.getProvider("pv")! };
  };
  const injectReceipt = (store: PairEvidenceStore, p: Record<string, unknown>, gates: Record<string, unknown>) => {
    const rid = `PQR_legacy_${Object.keys(gates).length}_${Math.random().toString(36).slice(2, 8)}`;
    store.put("provider_qualification", rid, {
      receipt_id: rid,
      provider_id: "pv",
      policy_version: "legacy",
      material_fingerprint: providerIdentityDigest(p),
      gates,
      issued_at: "2026-01-01T00:00:00Z",
    });
    const cur = store.get("provider", String(p.entry_id));
    store.put("provider", String(p.entry_id), {
      ...cur,
      lifecycle_state: "QUALIFIED",
      current_qualification_receipt_id: rid,
    }, Number(cur.version));
    return rid;
  };

  it("legacy receipt with missing required gates → PROVIDER_RECEIPT_CURRENT FAIL, non-routable", async () => {
    const { store } = makeCtx("r5r1");
    const { p } = await seedQualified(store);
    const me = mkModel(store, "pv", "m1");
    injectReceipt(store, p, {});
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_RECEIPT_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
  });

  it("legacy receipt with a failing required gate → FAIL, non-routable", async () => {
    const { store } = makeCtx("r5r2");
    const { p } = await seedQualified(store);
    const me = mkModel(store, "pv", "m1");
    injectReceipt(store, p, {
      PROVIDER_EXISTS: "PASS", AUTH_ACCEPTABLE: "PASS", PROTOCOL_PROBED: "PASS",
      HEALTH_ACCEPTABLE: "PASS", POLICY_PERMITS: "FAIL",
    });
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_RECEIPT_CURRENT).toBe("FAIL");
    expect(elig.eligible).toBe(false);
  });

  it("§12 control — complete valid receipt remains supported", async () => {
    const { store } = makeCtx("r5r3");
    const { p } = await seedQualified(store);
    const me = mkModel(store, "pv", "m1");
    injectReceipt(store, p, {
      PROVIDER_EXISTS: "PASS", AUTH_ACCEPTABLE: "PASS", PROTOCOL_PROBED: "PASS",
      HEALTH_ACCEPTABLE: "PASS", POLICY_PERMITS: "PASS",
    });
    const elig = providerModelEligibility(store, "pv", me);
    expect(elig.gates.PROVIDER_RECEIPT_CURRENT).toBe("PASS");
    expect(elig.eligible).toBe(true);
  });
});
