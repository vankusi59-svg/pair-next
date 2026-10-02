/**
 * provider-discovery — canonical provider discovery sources (P6).
 *
 * Port of donor provider_discovery.py semantics (a557df2): explicit sources
 * emit candidate claims which fold into the ProviderCatalog as DISCOVERED
 * entries only. Discovery never qualifies, never routes.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProviderCatalog, sanitizeDiagnostic } from "./provider-catalog.js";
import type { PairEvidenceStore } from "./store.js";

export interface DiscoveryContext {
  env: Record<string, string | undefined>;
  dshHome?: string;
  codexHome?: string;
  manifestPath?: string;
  executorDescriptors?: Array<Record<string, unknown>>;
}

export interface ProviderCandidate {
  provider_native_id: string;
  canonical_hint?: string;
  source_id: string;
  source_scope?: string;
  display_name?: string;
  provider_type?: string;
  protocol_family?: string;
  provider_family?: string;
  endpoint_reference?: string;
  base_url?: string;
  credential_reference_name?: string;
  credential_envs?: string[];
  capabilities?: string[];
  evidence_refs?: string[];
}

export interface ProviderDiscoverySource {
  readonly sourceId: string;
  supports(context: DiscoveryContext): boolean;
  discover(context: DiscoveryContext): ProviderCandidate[];
}

/** A. Credential env vars present in the environment → DISCOVERED. */
export class CredentialEnvSource implements ProviderDiscoverySource {
  readonly sourceId = "CREDENTIAL_REFERENCE";
  constructor(
    private readonly providers: Array<{
      provider_id: string;
      env_name: string;
      provider_type?: string;
      protocol_family?: string;
      endpoint_reference?: string;
      display_name?: string;
    }>,
  ) {}
  supports(): boolean {
    return true;
  }
  discover(context: DiscoveryContext): ProviderCandidate[] {
    const out: ProviderCandidate[] = [];
    for (const p of this.providers) {
      if (!context.env[p.env_name]) continue;
      out.push({
        provider_native_id: p.provider_id,
        canonical_hint: p.provider_id,
        source_id: this.sourceId,
        display_name: p.display_name ?? p.provider_id,
        provider_type: p.provider_type,
        protocol_family: p.protocol_family,
        provider_family: p.provider_id,
        endpoint_reference: p.endpoint_reference,
        credential_reference_name: p.env_name,
        credential_envs: [p.env_name],
      });
    }
    return out;
  }
}

/** B. DSH provider catalog — PAIR_DSH_HOME settings.yaml providers. */
export class DshConfigSource implements ProviderDiscoverySource {
  readonly sourceId = "DSH_PROVIDER_CATALOG";
  supports(context: DiscoveryContext): boolean {
    const home = context.dshHome;
    return !!home && fs.existsSync(path.join(home, "settings.yaml"));
  }
  discover(context: DiscoveryContext): ProviderCandidate[] {
    const home = context.dshHome!;
    const raw = YAML.parse(fs.readFileSync(path.join(home, "settings.yaml"), "utf8")) as Record<string, unknown>;
    const providers = ((raw["llm-pi-ai"] ?? {}) as Record<string, unknown>).providers as Record<string, Record<string, unknown>> | undefined;
    const out: ProviderCandidate[] = [];
    for (const [pid, cfg] of Object.entries(providers ?? {})) {
      out.push({
        provider_native_id: `DSH:${pid}`,
        canonical_hint: pid,
        source_id: this.sourceId,
        source_scope: home,
        display_name: String(cfg.displayName ?? cfg.display_name ?? pid),
        provider_type: String(cfg.api ?? "OPENAI_COMPATIBLE").toUpperCase().replace(/-/g, "_"),
        protocol_family: String(cfg.api ?? "OPENAI_COMPATIBLE").toUpperCase().replace(/-/g, "_"),
        provider_family: pid,
        endpoint_reference: cfg.baseURL ?? cfg.base_url ? String(cfg.baseURL ?? cfg.base_url) : undefined,
        credential_reference_name: cfg.apiKeyEnv ? String(cfg.apiKeyEnv) : undefined,
        // credential VALUES are never read here — only env var NAMES.
        credential_envs: cfg.apiKeyEnv ? [String(cfg.apiKeyEnv)] : [],
      });
    }
    return out;
  }
}

/** C. Operator static manifest — explicit declared providers. */
export class OperatorManifestSource implements ProviderDiscoverySource {
  readonly sourceId = "OPERATOR_MANIFEST";
  supports(context: DiscoveryContext): boolean {
    return !!context.manifestPath && fs.existsSync(context.manifestPath);
  }
  discover(context: DiscoveryContext): ProviderCandidate[] {
    const raw = JSON.parse(fs.readFileSync(context.manifestPath!, "utf8")) as { providers?: ProviderCandidate[] };
    return (raw.providers ?? []).map((p) => ({ ...p, source_id: this.sourceId }));
  }
}

/** D. Installed executor adapters that declare provider bindings. */
export class ExecutorAdvertisedSource implements ProviderDiscoverySource {
  readonly sourceId = "INSTALLED_ADAPTER";
  supports(context: DiscoveryContext): boolean {
    return (context.executorDescriptors ?? []).length > 0;
  }
  discover(context: DiscoveryContext): ProviderCandidate[] {
    const out: ProviderCandidate[] = [];
    for (const d of context.executorDescriptors ?? []) {
      const providers = d.provider_bindings ?? d.providers;
      if (!Array.isArray(providers)) continue;
      for (const p of providers as Array<Record<string, unknown>>) {
        out.push({
          provider_native_id: String(p.provider_id ?? p.provider_native_id),
          canonical_hint: p.canonical_hint ? String(p.canonical_hint) : undefined,
          source_id: this.sourceId,
          display_name: p.display_name ? String(p.display_name) : undefined,
          provider_type: p.provider_type ? String(p.provider_type) : undefined,
          protocol_family: p.protocol_family ? String(p.protocol_family) : undefined,
          provider_family: p.provider_family ? String(p.provider_family) : undefined,
          endpoint_reference: p.endpoint_reference ? String(p.endpoint_reference) : undefined,
          credential_reference_name: p.credential_env ? String(p.credential_env) : undefined,
          credential_envs: p.credential_env ? [String(p.credential_env)] : [],
        });
      }
    }
    return out;
  }
}

export function runProviderDiscovery(
  store: PairEvidenceStore,
  opts: {
    context: DiscoveryContext;
    sources?: ProviderDiscoverySource[];
    runId?: string;
    actor?: string;
  },
): {
  created: string[];
  updated: string[];
  unchanged: string[];
  errors: Record<string, string>;
  stale: string[];
  removed: string[];
  snapshots: string[];
  sync_id: string;
} {
  const catalog = new ProviderCatalog(store);
  const sources = opts.sources ?? defaultSources();
  const context = opts.context;
  const runId = opts.runId ?? `run-${Date.now()}`;
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const errors: Record<string, string> = {};
  const snapshots: string[] = [];
  const actor = opts.actor ?? "PAIR_PROVIDER_DISCOVERY";
  // Per-source claim sets drive Phase E §5 source-currentness
  // reconciliation: only COMPLETE source runs count as authoritative
  // observation evidence; a failed source can never falsely remove.
  const claimedBySource = new Map<string, Set<string>>();

  for (const source of sources) {
    if (!source.supports(context)) {
      // Phase E R1 §8-§10 — explicit source-disappearance semantics.
      // "Never configured for this installation" (no prior snapshot) is
      // NOT an absence observation — skip silently. A source that HAS a
      // prior COMPLETE snapshot but now reports supports()=false is a
      // previously-active authoritative source that definitively
      // disappeared: it claims nothing this run, so providers solely
      // dependent on it lose currentness through the normal bounded
      // streak (never an indefinite last-known-good grant). The run
      // records an ABSENT snapshot so the distinction is inspectable;
      // ABSENT counts as a completed-authoritative-empty claim, unlike
      // FAILED which never removes anything.
      if (!catalog.hasCompletedSnapshot(source.sourceId)) continue;
      claimedBySource.set(source.sourceId, new Set());
      const snap = catalog.recordProviderSnapshot(source.sourceId, "ABSENT", [], { runId, actor });
      snapshots.push(String(snap.snapshot_id));
      continue;
    }
    let candidates: ProviderCandidate[];
    try {
      candidates = [...source.discover(context)];
    } catch (err) {
      // One source failing must not corrupt the whole catalog — and must
      // not count as an absence observation either (FAILED snapshot).
      errors[source.sourceId] = sanitizeDiagnostic(err instanceof Error ? err.message : err) ?? "UNKNOWN";
      catalog.recordProviderSnapshot(source.sourceId, "FAILED", [], { runId, actor });
      continue;
    }
    const claimed = new Set<string>();
    for (const candidate of candidates) {
      try {
        const res = catalog.upsertCandidate(candidate as unknown as Record<string, unknown>, actor);
        const pid = String(res.entry.provider_id);
        claimed.add(pid);
        if (res.created) created.push(pid);
        else if (res.semanticNoOp) unchanged.push(pid);
        else updated.push(pid);
      } catch (err) {
        errors[String(candidate.provider_native_id)] =
          sanitizeDiagnostic(err instanceof Error ? err.message : err) ?? "UNKNOWN";
      }
    }
    claimedBySource.set(source.sourceId, claimed);
    const snap = catalog.recordProviderSnapshot(source.sourceId, "COMPLETE", [...claimed], { runId, actor });
    snapshots.push(String(snap.snapshot_id));
  }
  const rec = catalog.reconcileProviderAbsence(claimedBySource, { actor });
  const receipt = catalog.recordSyncReceipt(runId, { created, updated, unchanged, errors }, { actor });
  return {
    created,
    updated,
    unchanged,
    errors,
    stale: rec.stale,
    removed: rec.removed,
    snapshots,
    sync_id: String(receipt.sync_id),
  };
}

export function defaultSources(): ProviderDiscoverySource[] {
  return [new OperatorManifestSource(), new DshConfigSource(), new ExecutorAdvertisedSource()];
}
