/**
 * model-discovery — canonical model discovery adapters (P6).
 *
 * Port of donor model_discovery.py semantics (a557df2): per-provider-family
 * adapters emit model claims (DISCOVERED evidence only) folded into the
 * ModelEvidenceCatalog. Only MODEL_DISCOVERY_ELIGIBLE providers are scanned.
 *
 * Adapters:
 *  - OpenAICompatibleModelAdapter — GET {endpoint}/models (bounded GET,
 *    credential resolved from env NAME at call time, never persisted).
 *  - DshAcpModelAdapter — DSH configured providers/models from settings.yaml
 *    plus executor-advertised ACP session config options.
 *  - CodexObservedModelAdapter — Codex exposes no enumerable catalog; only
 *    models observed from real executions become OBSERVED claims.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { IntegrityError } from "./errors.js";
import type { ModelClaim } from "./model-catalog.js";
import { ModelEvidenceCatalog } from "./model-catalog.js";
import { utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";

const DEFAULT_TIMEOUT_S = 8;

export interface DiscoveryRunContext {
  env?: Record<string, string | undefined>;
  dshHome?: string;
  httpGet?: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  snapshotStatus?: string;
}

export abstract class ModelDiscoveryAdapter {
  abstract readonly adapterId: string;
  abstract supports(providerEntry: Record<string, unknown>): boolean;
  abstract listModels(
    providerEntry: Record<string, unknown>,
    context: DiscoveryRunContext,
  ): Promise<ModelClaim[]>;

  classifyError(err: unknown): string {
    const status =
      (err as { status?: number; code?: number })?.status ??
      (err as { status?: number; code?: number })?.code;
    const name = err instanceof Error ? err.name : String(err);
    if (/timeout/i.test(name) || /timeout/i.test(String(err))) return "UNREACHABLE";
    if (status === 401 || status === 403) return "ACCESS_DENIED";
    if (status === 404) return "UNSUPPORTED_PROTOCOL";
    if (status === 429) return "RATE_LIMITED";
    if (typeof status === "number" && status >= 500) return "UNREACHABLE";
    return "UNREACHABLE";
  }

  protected endpoint(entry: Record<string, unknown>): string | null {
    return (
      (entry.configured_endpoint_identity as string | null) ??
      (entry.endpoint_reference as string | null) ??
      null
    );
  }

  /** Resolve credential VALUE at call time — never persisted. */
  protected credentialValue(
    entry: Record<string, unknown>,
    env: Record<string, string | undefined>,
  ): string | null {
    const ref = entry.credential_reference_name;
    if (!ref) return null;
    return env[String(ref)] ?? null;
  }
}

async function defaultHttpGet(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_S * 1000);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
      redirect: "manual",
    });
    return { status: resp.status, body: (await resp.json()) as unknown };
  } finally {
    clearTimeout(timer);
  }
}

/** GET {endpoint}/models — OpenAI-compatible list-models shape. */
export class OpenAICompatibleModelAdapter extends ModelDiscoveryAdapter {
  readonly adapterId = "ADAPTER_OPENAI_COMPATIBLE";

  supports(entry: Record<string, unknown>): boolean {
    const t = String(entry.protocol_family ?? entry.provider_type ?? "").toUpperCase();
    return t === "OPENAI_COMPLETIONS" || t === "OPENAI_COMPATIBLE" || t === "HTTPS_API";
  }

  async listModels(entry: Record<string, unknown>, context: DiscoveryRunContext): Promise<ModelClaim[]> {
    const endpoint = this.endpoint(entry);
    if (!endpoint) throw new IntegrityError("FAIL_CLOSED_PROVIDER_NO_ENDPOINT", String(entry.provider_id));
    const env = context.env ?? (process.env as Record<string, string | undefined>);
    const token = this.credentialValue(entry, env);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const httpGet = context.httpGet ?? defaultHttpGet;
    const { status, body } = await httpGet(`${endpoint}/models`, headers);
    if (status >= 400) {
      const err = new Error(`HTTP_${status}`) as Error & { status: number };
      err.status = status;
      throw err;
    }
    const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
    return data
      .filter((m) => m.id)
      .map((m) => ({
        provider_id: String(entry.provider_id),
        provider_family: String(entry.provider_family ?? entry.provider_id),
        model_id: String(m.id),
        display_name: String(m.id),
        capability_hints: ["text_inference"],
        status_hint: "LISTED",
        observed_at: utcnow(),
      }));
  }
}

/** DSH catalog — configured providers/models from settings.yaml. */
export class DshConfigModelAdapter extends ModelDiscoveryAdapter {
  readonly adapterId = "ADAPTER_DSH_CONFIG";
  constructor(private readonly dshHome?: string) {
    super();
  }

  supports(entry: Record<string, unknown>): boolean {
    const source = (entry.sources ?? []) as string[];
    return source.includes("DSH_PROVIDER_CATALOG") || String(entry.provider_id).startsWith("dsh:");
  }

  async listModels(entry: Record<string, unknown>, context: DiscoveryRunContext): Promise<ModelClaim[]> {
    const home = context.dshHome ?? this.dshHome;
    if (!home) return [];
    const settingsPath = path.join(home, "settings.yaml");
    if (!fs.existsSync(settingsPath)) return [];
    const raw = YAML.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const providers = ((raw["llm-pi-ai"] ?? {}) as Record<string, unknown>).providers as
      | Record<string, Record<string, unknown>>
      | undefined;
    const cfg = providers?.[String(entry.provider_id)];
    if (!cfg) return [];
    const models = (cfg.models ?? []) as Array<Record<string, unknown> | string>;
    return models.map((m) => {
      const obj = typeof m === "string" ? { id: m } : m;
      return {
        provider_id: String(entry.provider_id),
        provider_family: String(entry.provider_family ?? entry.provider_id),
        model_id: String(obj.id),
        display_name: String(obj.name ?? obj.displayName ?? obj.id),
        capability_hints: Array.isArray(obj.capabilities) ? (obj.capabilities as string[]) : ["text_inference"],
        context_window_hint: obj.contextWindow ?? obj.context_window,
        status_hint: "CONFIGURED",
        observed_at: utcnow(),
      };
    });
  }
}

/** Executor-advertised claims — ACP session config options already probed live. */
export class ExecutorAdvertisedModelAdapter extends ModelDiscoveryAdapter {
  readonly adapterId = "ADAPTER_EXECUTOR_ADVERTISED";

  supports(): boolean {
    return true; // folds externally supplied observations
  }

  async listModels(entry: Record<string, unknown>, context: DiscoveryRunContext): Promise<ModelClaim[]> {
    const observed = (context as { observed_claims?: ModelClaim[] }).observed_claims ?? [];
    return observed.filter((c) => c.provider_id === entry.provider_id);
  }
}

export function selectAdapter(
  entry: Record<string, unknown>,
  adapters: ModelDiscoveryAdapter[],
): ModelDiscoveryAdapter | null {
  return adapters.find((a) => a.supports(entry)) ?? null;
}

export async function runModelDiscovery(
  store: PairEvidenceStore,
  opts: {
    providerIds?: string[];
    adapters?: ModelDiscoveryAdapter[];
    context?: DiscoveryRunContext;
    actor?: string;
  } = {},
): Promise<{
  scanned: string[];
  skipped: string[];
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  reappeared: string[];
  errors: Record<string, string>;
  snapshots: string[];
}> {
  const { ProviderCatalog } = await import("./provider-catalog.js");
  const providerCatalog = new ProviderCatalog(store);
  const catalog = new ModelEvidenceCatalog(store);
  const context = opts.context ?? {};
  const adapters = opts.adapters ?? [
    new DshConfigModelAdapter(context.dshHome),
    new OpenAICompatibleModelAdapter(),
    new ExecutorAdvertisedModelAdapter(),
  ];
  const actor = opts.actor ?? "PAIR_MODEL_DISCOVERY";

  let providers = providerCatalog.listProviders();
  if (opts.providerIds) {
    const wanted = new Set(opts.providerIds);
    providers = providers.filter((e) => wanted.has(String(e.provider_id)));
  }

  const results = {
    scanned: [] as string[],
    skipped: [] as string[],
    created: [] as string[],
    updated: [] as string[],
    unchanged: [] as string[],
    removed: [] as string[],
    reappeared: [] as string[],
    errors: {} as Record<string, string>,
    snapshots: [] as string[],
  };

  for (const entry of providers) {
    const pid = String(entry.provider_id);
    if (entry.lifecycle_state !== "MODEL_DISCOVERY_ELIGIBLE") {
      results.skipped.push(`${pid}:${entry.lifecycle_state}`);
      continue;
    }
    const adapter = selectAdapter(entry, adapters);
    if (!adapter) {
      results.skipped.push(`${pid}:NO_ADAPTER`);
      continue;
    }
    let claims: ModelClaim[];
    try {
      claims = await adapter.listModels(entry, context);
    } catch (err) {
      results.errors[pid] = adapter.classifyError(err);
      catalog.recordModelSnapshot(pid, adapter.adapterId, "FAILED", [], actor);
      continue;
    }
    const claimedIds = new Set<string>();
    for (const claim of claims) {
      const up = catalog.upsertModelClaim(claim, actor);
      catalog.recordModelClaimEvidence(adapter.adapterId, claim, String(up.entry.model_entry_id), actor);
      const mid = String(up.entry.model_entry_id);
      claimedIds.add(mid);
      if (up.created) results.created.push(mid);
      else if (up.reappeared) results.reappeared.push(mid);
      else if (up.semanticNoOp) results.unchanged.push(mid);
      else results.updated.push(mid);
    }
    const snapshotStatus = context.snapshotStatus ?? "COMPLETE";
    const snap = catalog.recordModelSnapshot(pid, adapter.adapterId, snapshotStatus, [...claimedIds], actor);
    results.snapshots.push(String(snap.snapshot_id));
    const rec = catalog.reconcileAbsence(pid, claimedIds, { snapshotStatus, actor });
    results.removed.push(...rec.removed);
    results.reappeared.push(...rec.reappeared);
    results.scanned.push(pid);
  }
  return results;
}
