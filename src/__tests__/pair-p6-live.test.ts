/**
 * P6 LIVE PROVIDER/MODEL DISCOVERY + QUALIFICATION — real vendor surface:
 *   DSH providers/models from PAIR_DSH_HOME settings.yaml (Groq declared),
 *   Groq GET /models (real API list, credential env name only),
 *   Codex model observed from a real `codex exec --json` run,
 *   real Tier-1 model liveness probe via Groq chat/completions (1 token).
 * Env-gated: skips cleanly without the P5.1 environment.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { PairEvidenceStore, PairControlPlane } from "../pair/index.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  CredentialEnvSource,
  DshConfigSource,
  ModelEvidenceCatalog,
  OpenAICompatibleModelAdapter,
  ProviderCatalog,
  ProviderValidator,
  canonicalModelId,
  ensureBinding,
  projectRoutableModels,
  qualifyBinding,
  qualifyModel,
  probeModel,
  runModelDiscovery,
  runProviderDiscovery,
} from "../pair/index.js";
import { DshConfigModelAdapter, ExecutorAdvertisedModelAdapter } from "../pair/model-discovery.js";
import { ExecutorRegistry } from "../pair/executor-registry.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DSH_HOME = process.env.PAIR_DSH_HOME ?? "/home/ubuntu/.pair-dsh-home";
const CODEX_HOME = process.env.CODEX_HOME ?? "/home/ubuntu/.codex";
const ROUTE = process.env.PAIR_DSH_MODEL_ROUTE ?? "";
const GROQ_MODEL = ROUTE.split(":")[1] ?? "openai/gpt-oss-120b";

const hasEnv =
  Boolean(process.env.GROQ_API_KEY) &&
  fs.existsSync(path.join(DSH_HOME, "settings.yaml")) &&
  fs.existsSync(path.join(CODEX_HOME, "auth.json"));

const describeLive = hasEnv ? describe : describe.skip;

let store: PairEvidenceStore;
let service: PairControlPlane;
let dir: string;

describeLive("P6 live qualification", () => {
  beforeAll(() => {
    expect(process.env.GROQ_API_KEY).toBeTruthy();
    dir = mkTmpDir("pair-p6-live-");
    store = new PairEvidenceStore(path.join(dir, "pair.db"));
    service = new PairControlPlane(store);
  });

  it("L1: real DSH provider discovery → groq DISCOVERED", () => {
    const res = runProviderDiscovery(store, {
      context: {
        env: process.env as Record<string, string | undefined>,
        dshHome: DSH_HOME,
      },
      sources: [
        new DshConfigSource(),
        new CredentialEnvSource([
          { provider_id: "groq", env_name: "GROQ_API_KEY", provider_type: "OPENAI_COMPATIBLE", endpoint_reference: "https://api.groq.com/openai/v1" },
        ]),
      ],
    });
    expect(res.created).toContain("groq");
    const entry = new ProviderCatalog(store).getProvider("groq")!;
    expect(entry.lifecycle_state).toBe("DISCOVERED");
    expect(entry.credential_envs).toContain("GROQ_API_KEY");
    expect(entry.sources).toContain("DSH_PROVIDER_CATALOG");
  });

  it("L2: real Groq access validation + provider qualification", async () => {
    const validator = new ProviderValidator(store);
    const acc = await validator.validateAccess("groq", {
      env: process.env as Record<string, string | undefined>,
      probe: async (entry) => {
        const adapter = new OpenAICompatibleModelAdapter();
        const models = await adapter.listModels(entry, {
          env: process.env as Record<string, string | undefined>,
        });
        return { outcome: "AUTH_OK", detail: `models=${models.length}` };
      },
    });
    expect(acc.outcome).toBe("AUTH_OK");
    const q = validator.qualify("groq", { env: process.env as Record<string, string | undefined> });
    expect(q.qualified).toBe(true);
    expect(new ProviderCatalog(store).getProvider("groq")!.lifecycle_state).toBe(
      "MODEL_DISCOVERY_ELIGIBLE",
    );
  }, 60_000);

  it("L3: real Groq model discovery via GET /models + DSH config models", async () => {
    const res = await runModelDiscovery(store, {
      adapters: [
        new OpenAICompatibleModelAdapter(),
        new DshConfigModelAdapter(DSH_HOME),
        new ExecutorAdvertisedModelAdapter(),
      ],
      context: {
        env: process.env as Record<string, string | undefined>,
        dshHome: DSH_HOME,
      },
    });
    expect(res.errors.groq).toBeUndefined();
    expect(res.created.length).toBeGreaterThan(0);
    const cat = new ModelEvidenceCatalog(store);
    const target = cat.getModel(canonicalModelId("groq", GROQ_MODEL));
    expect(target).toBeTruthy();
    expect(target!.lifecycle_state).toBe("DISCOVERED");
    expect(cat.listModels("groq").length).toBeGreaterThan(1);
  }, 60_000);

  it("L4: real Tier-1 liveness probe on the configured route model", async () => {
    const mid = canonicalModelId("groq", GROQ_MODEL);
    const receipt = await probeModel(store, mid, 1, {
      capability: "text_inference",
      probeFn: async (entry, profile) => {
        const started = Date.now();
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: String(entry.model_id),
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 4,
          }),
        });
        if (!resp.ok) return { result: resp.status === 429 ? "RATE_LIMITED" : "FAIL", latency_ms: Date.now() - started };
        return {
          result: "PASS",
          latency_ms: Date.now() - started,
          capability_evidence: { text_inference: "PASS" },
          requests_used: 1,
          tokens_used: Number(profile.token_cap ?? 0) > 0 ? 4 : 0,
        };
      },
    });
    expect(receipt.result).toBe("PASS");
    const entry = new ModelEvidenceCatalog(store).getModel(mid)!;
    expect(entry.lifecycle_state).toBe("PROBED");
  }, 60_000);

  it("L5: capability-scoped model qualification → QUALIFIED", () => {
    const mid = canonicalModelId("groq", GROQ_MODEL);
    const q = qualifyModel(store, mid, { capability_scope: ["text_inference"] });
    expect(q.qualified).toBe(true);
    expect(new ModelEvidenceCatalog(store).getModel(mid)!.lifecycle_state).toBe("QUALIFIED");
  });

  it("L6: DSH executor → groq provider → model binding → derived ROUTABLE", () => {
    // Register the already-live-qualified DSH executor descriptor.
    const registry = new ExecutorRegistry(service);
    registry.register({
      executor_id: "DEEPSEEK_HARNESS",
      executor_type: "EXTERNAL_ACP",
      capabilities: ["TEXT_INFERENCE"],
      health_state: "READY",
      status: "ENABLED",
      metadata: { qualification_state: "QUALIFIED", adapter_id: "deepseek_harness_acp", transport_type: "ACP_STDIO" },
    });
    const mid = canonicalModelId("groq", GROQ_MODEL);
    const binding = ensureBinding(service, {
      executor_id: "DEEPSEEK_HARNESS",
      provider_id: "groq",
      model_entry_id: mid,
      transport_compat: "ACP_STDIO",
      evidence_refs: ["PAIR_DSH_MODEL_ROUTE"],
    });
    qualifyBinding(service, binding.binding_id, { evidence_refs: ["L4_PROBE"] });
    const rows = projectRoutableModels(service);
    expect(rows).toHaveLength(1);
    expect(rows[0].routable).toBe(true);
    expect(Object.values(rows[0].gates).every((g) => g === "PASS")).toBe(true);
  });

  it("L7: Codex — real CLI model observation (session_meta + models_cache, no faked enumeration)", () => {
    const codex = fs.existsSync("/home/ubuntu/.local/bin/codex") ? "/home/ubuntu/.local/bin/codex" : "codex";
    const before = Date.now();
    execFileSync(
      codex,
      ["exec", "--json", "--skip-git-repo-check", "--cd", dir, "Reply with exactly: OK"],
      { env: { ...process.env, CODEX_HOME }, timeout: 180_000, encoding: "utf8" },
    );
    // Real evidence the CLI itself maintains: CODEX_HOME/models_cache.json
    // (fetched by the vendor runtime) + session_meta model_provider.
    const cachePath = path.join(CODEX_HOME, "models_cache.json");
    expect(fs.existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      models?: Array<{ slug?: string; display_name?: string; supported_in_api?: boolean }>;
    };
    const slugs = (cache.models ?? []).map((m) => m.slug).filter(Boolean) as string[];
    expect(slugs.length).toBeGreaterThan(0);
    const cat = new ModelEvidenceCatalog(store);
    for (const slug of slugs) {
      const up = cat.upsertModelClaim({
        provider_id: "codex-chatgpt",
        provider_family: "codex",
        model_id: slug,
        display_name: slug,
        status_hint: "EXECUTOR_ADVERTISED",
        observed_at: new Date().toISOString(),
      });
      expect(up.entry.lifecycle_state).toBe("DISCOVERED"); // observed ≠ qualified
    }
    // The model actually used by the live run is OBSERVED evidence (from the
    // session_meta the real CLI wrote), never a self-asserted qualification.
    const sessionsRoot = path.join(CODEX_HOME, "sessions");
    let providerSeen = "";
    const walk = (p: string): void => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl") && fs.statSync(full).mtimeMs >= before) {
          const first = fs.readFileSync(full, "utf8").split("\n")[0];
          const meta = (JSON.parse(first) as { payload?: { model_provider?: string } }).payload;
          if (meta?.model_provider) providerSeen = meta.model_provider;
        }
      }
    };
    walk(sessionsRoot);
    expect(providerSeen).toBeTruthy();
    expect(cat.listModels().filter((m) => m.provider_family === "codex").length).toBe(slugs.length);
  }, 200_000);

  it("L8: negative live — unreachable provider never qualifies", async () => {
    const catalog = new ProviderCatalog(store);
    catalog.upsertCandidate({
      provider_native_id: "dead-provider",
      canonical_hint: "dead-provider",
      source_id: "OPERATOR_MANIFEST",
      provider_type: "OPENAI_COMPATIBLE",
      endpoint_reference: "https://nonexistent.invalid/v1",
      credential_reference_name: "DEAD_API_KEY",
      credential_envs: ["DEAD_API_KEY"],
    });
    const validator = new ProviderValidator(store);
    const acc = await validator.validateAccess("dead-provider", {
      env: {},
      probe: async (entry) => {
        try {
          await new OpenAICompatibleModelAdapter().listModels(entry, { env: {} });
          return { outcome: "AUTH_OK" };
        } catch {
          return { outcome: "UNREACHABLE" };
        }
      },
    });
    expect(["CREDENTIAL_MISSING", "UNREACHABLE"]).toContain(acc.outcome);
    const q = validator.qualify("dead-provider", { env: {} });
    expect(q.qualified).toBe(false);
    const row = projectRoutableModels(service).find((r) => r.provider_id === "dead-provider");
    if (row) expect(row.routable).toBe(false);
  }, 60_000);

  it("L9: secret-leak scan over live catalog/db — env names only, no values", () => {
    const secrets = [process.env.GROQ_API_KEY].filter(Boolean) as string[];
    for (const row of store.db.prepare("SELECT entity_type, entity_id, payload FROM entities").all() as Array<{ entity_type: string; entity_id: string; payload: string }>) {
      for (const s of secrets) expect(row.payload.includes(s)).toBe(false);
    }
    for (const row of store.db.prepare("SELECT event_id, old_state, new_state, metadata_json FROM events").all() as Array<{ event_id: string; old_state: string | null; new_state: string | null; metadata_json: string | null }>) {
      for (const s of secrets) {
        for (const f of [row.old_state, row.new_state, row.metadata_json]) {
          if (f) expect(f.includes(s)).toBe(false);
        }
      }
    }
  });
});
