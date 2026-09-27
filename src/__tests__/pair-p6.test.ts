/**
 * P6 PROVIDER/MODEL DISCOVERY tests: canonical ProviderCatalog +
 * ModelEvidenceCatalog + discovery adapters + probing + derived ROUTABLE
 * projection. Discovery != qualification != routability — every promotion
 * must come from evidence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CredentialEnvSource,
  DshConfigSource,
  ExecutorAdvertisedModelAdapter,
  IntegrityError,
  ModelEvidenceCatalog,
  OpenAICompatibleModelAdapter,
  OperatorManifestSource,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  ProviderValidator,
  canonicalModelId,
  ensureBinding,
  normalizeEndpointIdentity,
  projectRoutableModels,
  probeModel,
  qualifyBinding,
  qualifyModel,
  runModelDiscovery,
  runProviderDiscovery,
} from "../pair/index.js";
import { DshConfigModelAdapter } from "../pair/model-discovery.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p6-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

function makeCtx(name: string, opts: { env?: Record<string, string | undefined> } = {}) {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  return { dir, store, service, env: opts.env ?? {} };
}

function seedProvider(
  ctx: ReturnType<typeof makeCtx>,
  providerId: string,
  opts: { lifecycle?: string; auth?: string; probe?: string; conditions?: string[] } = {},
) {
  const catalog = new ProviderCatalog(ctx.store);
  catalog.upsertCandidate(
    {
      provider_native_id: providerId,
      canonical_hint: providerId,
      source_id: "OPERATOR_MANIFEST",
      display_name: providerId,
      provider_type: "OPENAI_COMPATIBLE",
      protocol_family: "OPENAI_COMPATIBLE",
      provider_family: providerId,
      endpoint_reference: "https://api.example.test/v1",
      credential_reference_name: "TEST_API_KEY",
      credential_envs: ["TEST_API_KEY"],
    },
    "test",
  );
  const entry = catalog.getProvider(providerId)!;
  const body = { ...entry } as Record<string, unknown>;
  if (opts.lifecycle) body.lifecycle_state = opts.lifecycle;
  if (opts.auth) body.auth_state = opts.auth;
  if (opts.probe) body.probe_state = opts.probe;
  if (opts.conditions) body.conditions = opts.conditions;
  ctx.store.put("provider", String(entry.entry_id), body, Number(entry.version));
  return catalog.getProvider(providerId)!;
}

function registerExecutor(
  ctx: ReturnType<typeof makeCtx>,
  executorId: string,
  opts: { health?: string; qualified?: string; status?: string } = {},
) {
  ctx.service.registerExecutor({
    executor_id: executorId,
    executor_type: "EXTERNAL_ACP",
    capabilities: ["TEXT_INFERENCE"],
    health_state: opts.health ?? "READY",
    status: opts.status ?? "ENABLED",
    metadata: {
      adapter_id: "deepseek_harness_acp",
      transport_type: "ACP_STDIO",
      qualification_state: opts.qualified ?? "QUALIFIED",
      permission_modes: ["READ", "WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
    },
  });
}

const claim = (providerId: string, family: string, modelId: string, extra: Partial<Parameters<ModelEvidenceCatalog["upsertModelClaim"]>[0]> = {}) => ({
  provider_id: providerId,
  provider_family: family,
  model_id: modelId,
  display_name: modelId,
  capability_hints: ["text_inference"],
  status_hint: "LISTED",
  observed_at: "2026-01-01T00:00:00Z",
  ...extra,
});

class StubAdapter extends OpenAICompatibleModelAdapter {
  readonly adapterId = "STUB";
  constructor(private readonly claims: ReturnType<typeof claim>[], private readonly fail?: string) {
    super();
  }
  override supports(): boolean {
    return true;
  }
  override async listModels(): Promise<ReturnType<typeof claim>[]> {
    if (this.fail) throw Object.assign(new Error(this.fail), { status: Number(this.fail) });
    return this.claims;
  }
}

// ---------------------------------------------------------------------------
// positive A–K
// ---------------------------------------------------------------------------

describe("P6 discovery → catalog", () => {
  it("A. provider discovery → canonical ProviderCatalog entry (DISCOVERED, not qualified)", async () => {
    const ctx = makeCtx("a");
    const res = runProviderDiscovery(ctx.store, {
      context: { env: { TEST_API_KEY: "present" } },
      sources: [
        new CredentialEnvSource([
          { provider_id: "groq", env_name: "TEST_API_KEY", provider_type: "OPENAI_COMPATIBLE", endpoint_reference: "https://api.groq.com/openai/v1" },
        ]),
      ],
    });
    expect(res.created).toEqual(["groq"]);
    const entry = new ProviderCatalog(ctx.store).getProvider("groq")!;
    expect(entry.lifecycle_state).toBe("DISCOVERED");
    expect(entry.credential_envs).toEqual(["TEST_API_KEY"]);
    expect(entry.configured_endpoint_identity).toBe("https://api.groq.com/openai/v1");
  });

  it("B. model discovery → canonical model_entry (capability claims UNKNOWN)", async () => {
    const ctx = makeCtx("b");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const res = await runModelDiscovery(ctx.store, {
      adapters: [new StubAdapter([claim("groq", "groq", "openai/gpt-oss-120b")])],
    });
    expect(res.created).toHaveLength(1);
    const entry = new ModelEvidenceCatalog(ctx.store).listModels()[0];
    expect(entry.lifecycle_state).toBe("DISCOVERED");
    expect(entry.capability_claims).toEqual({ text_inference: "UNKNOWN" });
  });

  it("C. provider probe PASS → ACCESS_VALIDATED + probe_state PROBED", async () => {
    const ctx = makeCtx("c");
    seedProvider(ctx, "groq");
    const v = new ProviderValidator(ctx.store);
    const res = await v.validateAccess("groq", {
      env: { TEST_API_KEY: "present" },
      probe: async () => ({ outcome: "AUTH_OK", latency_ms: 42 }),
    });
    expect(res.outcome).toBe("AUTH_OK");
    const entry = new ProviderCatalog(ctx.store).getProvider("groq")!;
    expect(entry.lifecycle_state).toBe("ACCESS_VALIDATED");
    expect(entry.probe_state).toBe("PROBED");
  });

  it("D. model probe PASS → PROBED + capability evidence recorded", async () => {
    const ctx = makeCtx("d");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "openai/gpt-oss-120b");
    cat.upsertModelClaim(claim("groq", "groq", "openai/gpt-oss-120b"));
    const receipt = await probeModel(ctx.store, mid, 1, {
      probeFn: () => ({ result: "PASS", latency_ms: 10, capability_evidence: { text_inference: "PASS" }, requests_used: 1, tokens_used: 8 }),
      capability: "text_inference",
    });
    expect(receipt.result).toBe("PASS");
    const entry = cat.getModel(mid)!;
    expect(entry.lifecycle_state).toBe("PROBED");
    expect(entry.probe_receipt_ids).toContain(receipt.probe_id);
  });

  it("E. qualification PASS with evidence (provider + model receipts)", async () => {
    const ctx = makeCtx("e");
    seedProvider(ctx, "groq", { lifecycle: "ACCESS_VALIDATED", auth: "AUTH_OK", probe: "PROBED" });
    const v = new ProviderValidator(ctx.store);
    const q = v.qualify("groq", { env: { TEST_API_KEY: "x" } });
    expect(q.qualified).toBe(true);
    expect(q.receipt!.material_fingerprint).toBeTruthy();
    expect(new ProviderCatalog(ctx.store).getProvider("groq")!.lifecycle_state).toBe("MODEL_DISCOVERY_ELIGIBLE");

    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "openai/gpt-oss-120b");
    cat.upsertModelClaim(claim("groq", "groq", "openai/gpt-oss-120b"));
    await probeModel(ctx.store, mid, 1, {
      probeFn: () => ({ result: "PASS", capability_evidence: { text_inference: "PASS" } }),
      capability: "text_inference",
    });
    const mq = qualifyModel(ctx.store, mid, { capability_scope: ["text_inference"] });
    expect(mq.qualified).toBe(true);
    expect(cat.getModel(mid)!.lifecycle_state).toBe("QUALIFIED");
  });

  it("F/G/H. ROUTABLE derived true only when executor+provider+model+binding all pass", () => {
    const ctx = makeCtx("f");
    seedProvider(ctx, "groq", { lifecycle: "QUALIFIED", auth: "AUTH_OK", probe: "PROBED" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "openai/gpt-oss-120b");
    cat.upsertModelClaim(claim("groq", "groq", "openai/gpt-oss-120b"));
    registerExecutor(ctx, "DEEPSEEK_HARNESS");
    const binding = ensureBinding(ctx.service, {
      executor_id: "DEEPSEEK_HARNESS",
      provider_id: "groq",
      model_entry_id: mid,
      transport_compat: "ACP_STDIO",
    });

    // not routable: model unqualified + binding unqualified
    let rows = projectRoutableModels(ctx.service);
    expect(rows[0].routable).toBe(false);
    expect(rows[0].gates.MODEL_QUALIFIED).toBe("FAIL");
    expect(rows[0].gates.BINDING_QUALIFIED).toBe("FAIL");

    // qualify model (evidence) + binding → routable
    cat.issueQualificationReceipt(mid, { capability_scope: ["text_inference"], verifier: "test", evidence_refs: ["PRB_x"] });
    qualifyBinding(ctx.service, binding.binding_id, { evidence_refs: ["ev1"] });
    rows = projectRoutableModels(ctx.service);
    expect(rows).toHaveLength(1);
    expect(rows[0].routable).toBe(true);
    expect(Object.values(rows[0].gates).every((g) => g === "PASS")).toBe(true);
  });

  it("I. restart preserves provider/model catalogs + evidence", async () => {
    const ctx = makeCtx("i");
    seedProvider(ctx, "groq", { lifecycle: "QUALIFIED", auth: "AUTH_OK" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "openai/gpt-oss-120b");
    cat.upsertModelClaim(claim("groq", "groq", "openai/gpt-oss-120b"));
    await probeModel(ctx.store, mid, 0, {});
    ctx.store.close();

    const reopened = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const entry = new ProviderCatalog(reopened).getProvider("groq")!;
    expect(entry.lifecycle_state).toBe("QUALIFIED");
    const model = new ModelEvidenceCatalog(reopened).getModel(mid)!;
    expect(model.probe_receipt_ids).toHaveLength(1);
    reopened.close();
  });

  it("J. repeated sync produces no duplicates (semantic no-op)", async () => {
    const ctx = makeCtx("j");
    const src = new CredentialEnvSource([{ provider_id: "groq", env_name: "TEST_API_KEY" }]);
    const r1 = runProviderDiscovery(ctx.store, { context: { env: { TEST_API_KEY: "x" } }, sources: [src] });
    const r2 = runProviderDiscovery(ctx.store, { context: { env: { TEST_API_KEY: "x" } }, sources: [src] });
    expect(r1.created).toEqual(["groq"]);
    expect(r2.unchanged).toEqual(["groq"]);
    expect(new ProviderCatalog(ctx.store).listProviders()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// negative 1–24
// ---------------------------------------------------------------------------

describe("P6 negatives", () => {
  it("1. discovered provider is NOT qualified/routable", async () => {
    const ctx = makeCtx("n1");
    seedProvider(ctx, "groq");
    const q = new ProviderValidator(ctx.store).qualify("groq", { env: { TEST_API_KEY: "x" } });
    expect(q.qualified).toBe(false);
    expect(q.gates.PROTOCOL_PROBED).toBe("FAIL");
    expect(new ProviderCatalog(ctx.store).getProvider("groq")!.lifecycle_state).toBe("DISCOVERED");
  });

  it("2. discovered model is NOT qualified", () => {
    const ctx = makeCtx("n2");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    const q = qualifyModel(ctx.store, mid, { capability_scope: ["text_inference"] });
    expect(q.qualified).toBe(false);
    expect(cat.getModel(mid)!.lifecycle_state).toBe("DISCOVERED");
  });

  it("3. configured model is NOT routable without qualification", () => {
    const ctx = makeCtx("n3");
    seedProvider(ctx, "groq", { lifecycle: "QUALIFIED", auth: "AUTH_OK", probe: "PROBED" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    registerExecutor(ctx, "DEEPSEEK_HARNESS");
    const b = ensureBinding(ctx.service, { executor_id: "DEEPSEEK_HARNESS", provider_id: "groq", model_entry_id: mid });
    qualifyBinding(ctx.service, b.binding_id);
    const row = projectRoutableModels(ctx.service)[0];
    expect(row.routable).toBe(false);
    expect(row.gates.MODEL_QUALIFIED).toBe("FAIL");
  });

  it("4. missing credential → not routable", async () => {
    const ctx = makeCtx("n4");
    makeRoutableRow(ctx, "groq"); // fully qualified baseline
    const v = new ProviderValidator(ctx.store);
    const res = await v.validateAccess("groq", { env: {} }); // no TEST_API_KEY
    expect(res.outcome).toBe("CREDENTIAL_MISSING");
    const row = projectRoutableModels(ctx.service)[0];
    expect(row.gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("5. failed provider probe → not routable", async () => {
    const ctx = makeCtx("n5");
    seedProvider(ctx, "groq");
    const v = new ProviderValidator(ctx.store);
    const res = await v.validateAccess("groq", {
      env: { TEST_API_KEY: "x" },
      probe: async () => ({ outcome: "UNREACHABLE" }),
    });
    expect(res.outcome).toBe("UNREACHABLE");
    const q = v.qualify("groq", { env: { TEST_API_KEY: "x" } });
    expect(q.qualified).toBe(false);
    expect(q.gates.PROTOCOL_PROBED).toBe("FAIL");
  });

  it("6. failed model probe → not qualified/routable", async () => {
    const ctx = makeCtx("n6");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    const receipt = await probeModel(ctx.store, mid, 1, {
      probeFn: () => ({ result: "FAIL", capability_evidence: { text_inference: "FAIL" } }),
      capability: "text_inference",
    });
    expect(receipt.result).toBe("FAIL");
    expect(qualifyModel(ctx.store, mid, { capability_scope: ["text_inference"] }).qualified).toBe(false);
  });

  it("7. unsupported required capability → not qualified", async () => {
    const ctx = makeCtx("n7");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    await probeModel(ctx.store, mid, 2, {
      probeFn: () => ({ result: "PASS", capability_evidence: { text_inference: "PASS" } }),
      capability: "text_inference",
    });
    expect(qualifyModel(ctx.store, mid, { capability_scope: ["vision"] }).qualified).toBe(false);
  });

  it("8. disabled executor binding → not routable", () => {
    const ctx = makeCtx("n8");
    const row = makeRoutableRow(ctx, "groq", { execOpts: { status: "DISABLED" } });
    expect(row.gates.EXECUTOR_ENABLED).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("9. unhealthy executor → not routable", () => {
    const ctx = makeCtx("n9");
    const row = makeRoutableRow(ctx, "groq", { execOpts: { health: "DEGRADED" } });
    expect(row.gates.EXECUTOR_HEALTHY).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("10. 401/403 → ACCESS_DENIED auth failure, fail closed", async () => {
    const ctx = makeCtx("n10");
    makeRoutableRow(ctx, "groq"); // qualified baseline
    const catalog = new ProviderCatalog(ctx.store);
    const prov = catalog.getProvider("groq")!;
    ctx.store.put("provider", String(prov.entry_id), { ...prov, lifecycle_state: "MODEL_DISCOVERY_ELIGIBLE" } as Record<string, unknown>, Number(prov.version));
    const res = await runModelDiscovery(ctx.store, {
      adapters: [new StubAdapter([], "401")],
    });
    expect(res.errors.groq).toBe("ACCESS_DENIED");
    const v = new ProviderValidator(ctx.store);
    const acc = await v.validateAccess("groq", {
      env: { TEST_API_KEY: "x" },
      probe: async () => ({ outcome: "ACCESS_DENIED" }),
    });
    expect(acc.entry.auth_state).toBe("AUTH_FAILED");
    const row = projectRoutableModels(ctx.service)[0];
    expect(row.gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("11. 429 → RATE_LIMITED classification, entry preserved", async () => {
    const ctx = makeCtx("n11");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    cat.upsertModelClaim(claim("groq", "groq", "existing-model"));
    const res = await runModelDiscovery(ctx.store, { adapters: [new StubAdapter([], "429")] });
    expect(res.errors.groq).toBe("RATE_LIMITED");
    // prior catalog retained
    expect(cat.listModels().map((m) => m.model_id)).toEqual(["existing-model"]);
    const snap = ctx.store.list("model_snapshot")[0];
    expect(snap.status).toBe("FAILED");
  });

  it("12. 404/disappeared model → record retained, current route disabled", () => {
    const ctx = makeCtx("n12");
    const row = makeRoutableRow(ctx, "groq", { modelConditions: ["REMOVED"] });
    expect(row.gates.MODEL_NOT_REVOKED).toBe("FAIL");
    expect(row.routable).toBe(false);
    const cat = new ModelEvidenceCatalog(ctx.store);
    expect(cat.getModel(canonicalModelId("groq", "m1"))).toBeTruthy(); // history retained
  });

  it("13. malformed catalog response does not erase known-good catalog", async () => {
    const ctx = makeCtx("n13");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    cat.upsertModelClaim(claim("groq", "groq", "known-good"));
    const res = await runModelDiscovery(ctx.store, {
      adapters: [new StubAdapter([], "503")],
    });
    expect(res.errors.groq).toBe("UNREACHABLE");
    expect(cat.listModels()).toHaveLength(1);
  });

  it("14. disappeared model becomes STALE then REMOVED — never deleted", async () => {
    const ctx = makeCtx("n14");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "gone");
    cat.upsertModelClaim(claim("groq", "groq", "gone"));
    for (let i = 0; i < 3; i++) {
      await runModelDiscovery(ctx.store, { adapters: [new StubAdapter([])] });
    }
    const entry = cat.getModel(mid)!;
    expect(entry).toBeTruthy();
    expect(entry.conditions).toContain("REMOVED");
  });

  it("15. catalog sync is idempotent (claim fold semantic_no_op)", async () => {
    const ctx = makeCtx("n15");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const adapter = new StubAdapter([claim("groq", "groq", "m1")]);
    await runModelDiscovery(ctx.store, { adapters: [adapter] });
    const res2 = await runModelDiscovery(ctx.store, { adapters: [adapter] });
    expect(res2.unchanged).toHaveLength(1);
    expect(new ModelEvidenceCatalog(ctx.store).listModels()).toHaveLength(1);
  });

  it("16. conflicting provider identity fails closed", () => {
    const ctx = makeCtx("n16");
    const catalog = new ProviderCatalog(ctx.store);
    catalog.upsertCandidate({
      provider_native_id: "groq",
      canonical_hint: "groq",
      source_id: "OPERATOR_MANIFEST",
      provider_type: "OPENAI_COMPATIBLE",
    });
    expect(() =>
      catalog.upsertCandidate({
        provider_native_id: "groq",
        canonical_hint: "groq",
        source_id: "OPERATOR_MANIFEST",
        provider_type: "GEMINI_NATIVE",
      }),
    ).toThrow(IntegrityError);
  });

  it("17. conflicting/missing model identity fails closed", () => {
    const ctx = makeCtx("n17");
    const cat = new ModelEvidenceCatalog(ctx.store);
    expect(() => cat.upsertModelClaim({ provider_id: "groq", provider_family: "groq", model_id: "" })).toThrow(
      IntegrityError,
    );
  });

  it("18. duplicate discovery does not duplicate canonical rows", async () => {
    const ctx = makeCtx("n18");
    seedProvider(ctx, "groq", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const adapter = new StubAdapter([claim("groq", "groq", "m1"), claim("groq", "groq", "m1")]);
    await runModelDiscovery(ctx.store, { adapters: [adapter] });
    expect(new ModelEvidenceCatalog(ctx.store).listModels()).toHaveLength(1);
  });

  it("19. stale model rejected before selection", () => {
    const ctx = makeCtx("n19");
    const row = makeRoutableRow(ctx, "groq", { modelConditions: ["STALE"] });
    expect(row.gates.MODEL_NOT_STALE).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("20. revoked/deprecated model rejected", () => {
    const ctx = makeCtx("n20");
    const row = makeRoutableRow(ctx, "groq", { modelConditions: ["DEPRECATED"] });
    expect(row.gates.MODEL_NOT_REVOKED).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("21. capability claim without qualifying evidence rejected", () => {
    const ctx = makeCtx("n21");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1", { capability_hints: ["tools"] }));
    expect(cat.getModel(mid)!.capability_claims).toEqual({ tools: "UNKNOWN" });
    expect(qualifyModel(ctx.store, mid, { capability_scope: ["tools"] }).qualified).toBe(false);
  });

  it("22. model cannot bypass mission/executor routing authority", () => {
    const ctx = makeCtx("n22");
    // Qualified model + binding cannot make an UNQUALIFIED executor routable.
    const row = makeRoutableRow(ctx, "groq", { execOpts: { qualified: "UNQUALIFIED" } });
    expect(row.gates.EXECUTOR_QUALIFIED).toBe("FAIL");
    expect(row.routable).toBe(false);
  });

  it("23. cognitive-layer claims never qualify a model", () => {
    const ctx = makeCtx("n23");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    // A Layer-A cognitive assertion is only an entity — it carries no probe
    // receipts, so qualification remains impossible.
    ctx.store.put("cognitive_assertion", "ca1", { model_entry_id: mid, assertion: "supports tools" }, 0);
    expect(qualifyModel(ctx.store, mid, { capability_scope: ["tools"] }).qualified).toBe(false);
  });

  it("24. credential value never appears in catalog/evidence", () => {
    const ctx = makeCtx("n24");
    const catalog = new ProviderCatalog(ctx.store);
    expect(() =>
      catalog.upsertCandidate({
        provider_native_id: "groq",
        api_key: "sk-live-secret",
        source_id: "OPERATOR_MANIFEST",
      }),
    ).toThrow(/SECRET/);
    // store-level guard too
    expect(() => ctx.store.put("provider", "x", { provider_id: "x", api_key: "v" }, 0)).toThrow(/SECRET/);
  });

  it("tier>=1 probe without probe_fn fails closed; over-cap → CAP_EXCEEDED", async () => {
    const ctx = makeCtx("n25");
    const cat = new ModelEvidenceCatalog(ctx.store);
    const mid = canonicalModelId("groq", "m1");
    cat.upsertModelClaim(claim("groq", "groq", "m1"));
    await expect(probeModel(ctx.store, mid, 1)).rejects.toThrow(/PROBE_NOT_CONFIGURED/);
    const receipt = await probeModel(ctx.store, mid, 1, {
      probeFn: () => ({ result: "PASS", requests_used: 5 }),
    });
    expect(receipt.result).toBe("CAP_EXCEEDED");
  });

  it("endpoint normalization drops query/userinfo, keeps scheme+host+path", () => {
    expect(normalizeEndpointIdentity("HTTPS://User:pw@API.Example.COM:443/v1/?key=x")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeEndpointIdentity("env:GROQ_API_KEY")).toBe("env:GROQ_API_KEY");
  });

  it("DSH settings.yaml source discovers configured provider (Groq)", async () => {
    const ctx = makeCtx("dsh-src");
    const home = path.join(ctx.dir, "dsh-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "settings.yaml"),
      `llm-pi-ai:\n  providers:\n    groq:\n      displayName: Groq\n      apiKeyEnv: GROQ_API_KEY\n      api: openai-completions\n      baseURL: https://api.groq.com/openai/v1\n      models:\n        - id: openai/gpt-oss-120b\n        - id: openai/gpt-oss-20b\n`,
    );
    const res = runProviderDiscovery(ctx.store, {
      context: { env: {}, dshHome: home },
      sources: [new DshConfigSource()],
    });
    expect(res.created).toEqual(["groq"]);
    const entry = new ProviderCatalog(ctx.store).getProvider("groq")!;
    expect(entry.provider_type).toBe("OPENAI_COMPLETIONS");
    expect(entry.credential_envs).toEqual(["GROQ_API_KEY"]);
    // model discovery via DSH config adapter
    ctx.store.put("provider", String(entry.entry_id), { ...entry, lifecycle_state: "MODEL_DISCOVERY_ELIGIBLE" } as Record<string, unknown>, Number(entry.version));
    const md = await runModelDiscovery(ctx.store, {
      adapters: [new DshConfigModelAdapter(home)],
      context: { dshHome: home },
    });
    expect(md.created).toHaveLength(2);
    const models = new ModelEvidenceCatalog(ctx.store).listModels("groq");
    expect(models.map((m) => m.model_id).sort()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  it("executor-advertised claims fold through ExecutorAdvertisedModelAdapter", async () => {
    const ctx = makeCtx("adv");
    seedProvider(ctx, "dsh-advertised", { lifecycle: "MODEL_DISCOVERY_ELIGIBLE" });
    const res = await runModelDiscovery(ctx.store, {
      adapters: [new ExecutorAdvertisedModelAdapter()],
      context: {
        observed_claims: [
          claim("dsh-advertised", "groq", "openai/gpt-oss-120b", { status_hint: "EXECUTOR_ADVERTISED" }),
        ],
      },
    });
    expect(res.created).toHaveLength(1);
  });
});

/** Build a fully-qualified provider+model+executor+binding, then project. */
function makeRoutableRow(
  ctx: ReturnType<typeof makeCtx>,
  providerId: string,
  opts: { execOpts?: { health?: string; qualified?: string; status?: string }; modelConditions?: string[] } = {},
) {
  seedProvider(ctx, providerId, { lifecycle: "QUALIFIED", auth: "AUTH_OK", probe: "PROBED" });
  const cat = new ModelEvidenceCatalog(ctx.store);
  const mid = canonicalModelId(providerId, "m1");
  cat.upsertModelClaim(claim(providerId, providerId, "m1"));
  cat.issueQualificationReceipt(mid, { capability_scope: ["text_inference"], verifier: "test", evidence_refs: [] });
  if (opts.modelConditions) cat.setConditions(mid, opts.modelConditions);
  registerExecutor(ctx, "DEEPSEEK_HARNESS", opts.execOpts);
  const b = ensureBinding(ctx.service, {
    executor_id: "DEEPSEEK_HARNESS",
    provider_id: providerId,
    model_entry_id: mid,
  });
  qualifyBinding(ctx.service, b.binding_id);
  return projectRoutableModels(ctx.service)[0];
}
