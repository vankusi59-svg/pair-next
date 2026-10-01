/**
 * DshExecutorAdapter — governed DeepSeek Harness executor (ACP_STDIO).
 *
 * Port of donor deepseek_harness_acp.py (a557df2): launch `dsh --profile acp`,
 * pinned DSH_HOME, credential env resolvable but never read into evidence,
 * model route pinned through session/set_config_option. Capabilities are
 * reported only after live qualification — an unqualified DSH is never
 * eligible.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AcpExecutorAdapterBase } from "./acp-executor.js";
import type { AcpLaunch, AcpProcess } from "./acp-transport.js";

export const DSH_EXECUTOR_ID = "DEEPSEEK_HARNESS";
export const DSH_RUNTIME_TYPE = "DEEPSEEK_HARNESS_ACP";
export const FROZEN_DSH_PACKAGE_VERSION = "0.1.5-rc.3";
export const DSH_ACP_AGENT_NAME = "deepseek-harness-acp";
export const DSH_MODEL_CONFIG_ID = "model";
export const DSH_DEFAULT_MODEL_ROUTE: readonly [string, string] = [
  "gemini",
  "gemini-3.1-flash-lite",
];
export const DSH_OFFICIAL_CREDENTIAL_ENV = "DEEPSEEK_API_KEY";

export const DSH_CAPABILITY_IDS = [
  "CODE_GENERATION",
  "CODE_EDITING",
  "FILE_OPERATIONS",
  "SHELL_EXECUTION",
  "REASONING",
  // Compose the user-facing deliverable file (outbox/report.txt) that the
  // Telegram bridge forwards to the operator.
  "TELEGRAM_DELIVERY",
] as const;

function modelRoute(env: (n: string) => string | undefined): [string, string] {
  const raw = env("PAIR_DSH_MODEL_ROUTE");
  if (raw) {
    const m = raw.match(/^([a-z0-9_-]+):(.+)$/i);
    if (m) return [m[1], m[2]];
  }
  return [...DSH_DEFAULT_MODEL_ROUTE];
}

function credentialEnvName(provider: string): string {
  return provider === "deepseek-official" ? DSH_OFFICIAL_CREDENTIAL_ENV : `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export class DshExecutorAdapter extends AcpExecutorAdapterBase {
  readonly executor_id = DSH_EXECUTOR_ID;
  readonly runtime_type = DSH_RUNTIME_TYPE;
  override readonly invocation_method = "acp stdio json-rpc (dsh --profile acp)";
  protected override readonly capability_ids = [...DSH_CAPABILITY_IDS];
  private readonly configuredEntry: string | null;
  private readonly roleAssertion: ((provider: string, model: string) => void) | null;

  private readonly routeResolver: ((routeId: string) => Record<string, unknown> | null) | null;

  constructor(
    deps: ConstructorParameters<typeof AcpExecutorAdapterBase>[0] & {
      dshEntry?: string;
      /** Resolve a canonical route entity (route-registry row) by id. When
       * the dispatched task was bound to a model route at route-decision
       * time, its metadata pins provider/model/credential env — enabling
       * route-level failover instead of the env-pinned default. */
      routeResolver?: (routeId: string) => Record<string, unknown> | null;
      /**
       * Phase A role seam: invoked with the resolved (provider, model)
       * immediately before the route is pinned on a live DSH session — the
       * caller proves the model holds DSH_EXECUTION role; throw = fail closed.
       */
      modelRoleAssertion?: (provider: string, model: string) => void;
    },
  ) {
    super(deps);
    this.configuredEntry = deps.dshEntry ?? null;
    this.routeResolver = deps.routeResolver ?? null;
    this.roleAssertion = deps.modelRoleAssertion ?? null;
  }

  /** Model route for a dispatch: the route the router bound onto the
   * governed task when it is a model route, else the env-pinned default. */
  private resolvedModelRoute(task?: Record<string, unknown>): { provider: string; model: string; credentialEnv: string } {
    const rid = task ? String(task.selected_route_id ?? "") : "";
    const route = rid && this.routeResolver ? this.routeResolver(rid) : null;
    const md = (route?.metadata as Record<string, unknown> | undefined) ?? {};
    if (md.provider_id && md.model_id) {
      const provider = String(md.provider_id);
      return {
        provider,
        model: String(md.model_id),
        credentialEnv: String(md.credential_env ?? this.providerCredentialEnv(provider) ?? credentialEnvName(provider)),
      };
    }
    const [provider, model] = modelRoute(this.envOf.bind(this));
    return { provider, model, credentialEnv: this.providerCredentialEnv(provider) ?? credentialEnvName(provider) };
  }

  private envOf(name: string): string | undefined {
    return (this.deps.envReader ?? ((n) => process.env[n]))(name);
  }

  protected resolveLaunch(): AcpLaunch | null {
    const entry = this.configuredEntry ?? this.envOf("PAIR_DSH_ACP_PATH") ?? null;
    if (entry) {
      return fs.existsSync(entry)
        ? { command: "node", args: [entry, "--profile", "acp"], env: {}, evidence: { entry } }
        : null;
    }
    // Probe PATH for a real `dsh`.
    try {
      const resolved = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
      if (resolved) {
        return {
          command: resolved,
          args: ["--profile", "acp"],
          env: {},
          evidence: { entry: resolved },
        };
      }
    } catch {
      /* not installed */
    }
    return null;
  }

  protected override providerEnv(task?: Record<string, unknown>): Record<string, string> {
    const env: Record<string, string> = { DSH_TELEMETRY_DISABLED: "1" };
    const home = this.envOf("PAIR_DSH_HOME");
    if (home) env.DSH_HOME = home;
    // Donor parity: resolved credential pinned into child env; never evidence.
    const credName = this.resolvedModelRoute(task).credentialEnv;
    const cred = this.envOf(credName);
    if (cred) env[credName] = cred;
    return env;
  }

  protected override credentialEnvNames(): string[] {
    const [provider] = modelRoute(this.envOf.bind(this));
    if (provider === "deepseek-official") return [DSH_OFFICIAL_CREDENTIAL_ENV];
    // The provider's own config declares its credential env name (e.g.
    // cloudflare → CLOUDFLARE_API_TOKEN) — authoritative over the
    // <PROVIDER>_API_KEY convention.
    const declared = this.providerCredentialEnv(provider);
    if (declared) return [declared];
    return [`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
  }

  private providerCredentialEnv(provider: string): string | null {
    const home = this.envOf("PAIR_DSH_HOME");
    if (!home) return null;
    const settingsPath = path.join(home, "settings.yaml");
    if (!fs.existsSync(settingsPath)) return null;
    try {
      const raw = YAML.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const providers = ((raw?.["llm-pi-ai"] ?? {}) as Record<string, unknown>).providers as
        | Record<string, Record<string, unknown>>
        | undefined;
      const apiKeyEnv = providers?.[provider]?.apiKeyEnv;
      return apiKeyEnv ? String(apiKeyEnv) : null;
    } catch {
      return null;
    }
  }

  protected override providerProbe(launch: AcpLaunch, limitations: string[]): Record<string, unknown> {
    const [provider, model] = modelRoute(this.envOf.bind(this));
    let dshVersion: string | null = null;
    try {
      dshVersion = execFileSync(launch.command, [...launch.args.slice(0, -2), "--version"], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim() || null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        limitations.push(`DSH_EXECUTABLE_NOT_FOUND:${launch.command}`);
      }
      /* other failures are best-effort; real handshake happens in dispatch */
    }
    const credentialEnv = this.credentialEnvNames()[0];
    const authenticated = Boolean(this.envOf(credentialEnv));
    if (!authenticated) limitations.push(`DSH_CREDENTIAL_NOT_RESOLVABLE:${credentialEnv}`);
    return {
      dsh_version: dshVersion,
      dsh_home: this.envOf("PAIR_DSH_HOME") ?? null,
      model_route: [provider, model],
      credential_env: credentialEnv,
      authenticated,
    };
  }

  protected override async postSessionSetup(
    proc: AcpProcess,
    sessionId: string,
    _session: Record<string, unknown>,
    _features: Record<string, unknown>,
    task: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { provider, model } = this.resolvedModelRoute(task);
    // Runtime role enforcement: the model about to execute DSH work must be
    // canonically authorized as DSH_EXECUTION (Planner pool is disjoint).
    this.roleAssertion?.(provider, model);
    const value = JSON.stringify([provider, model]);
    const resp = await proc.setConfigOption(sessionId, DSH_MODEL_CONFIG_ID, value, 30);
    return { model_route: [provider, model], selected_route_id: task.selected_route_id ?? null, model_config: { config_id: DSH_MODEL_CONFIG_ID, response: resp } };
  }
}
