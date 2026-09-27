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
import { AcpExecutorAdapterBase } from "./acp-executor.js";
import type { AcpLaunch, AcpProcess } from "./acp-transport.js";

export const DSH_EXECUTOR_ID = "DEEPSEEK_HARNESS";
export const DSH_RUNTIME_TYPE = "DEEPSEEK_HARNESS_ACP";
export const FROZEN_DSH_PACKAGE_VERSION = "0.1.5-rc.3";
export const DSH_ACP_AGENT_NAME = "deepseek-harness-acp";
export const DSH_MODEL_CONFIG_ID = "model";
export const DSH_DEFAULT_MODEL_ROUTE: readonly [string, string] = [
  "deepseek-official",
  "deepseek-v4-flash",
];
export const DSH_OFFICIAL_CREDENTIAL_ENV = "DEEPSEEK_API_KEY";

export const DSH_CAPABILITY_IDS = [
  "CODE_GENERATION",
  "CODE_EDITING",
  "FILE_OPERATIONS",
  "SHELL_EXECUTION",
  "REASONING",
] as const;

function modelRoute(env: (n: string) => string | undefined): [string, string] {
  const raw = env("PAIR_DSH_MODEL_ROUTE");
  if (raw) {
    const m = raw.match(/^([a-z0-9_-]+):(.+)$/i);
    if (m) return [m[1], m[2]];
  }
  return [...DSH_DEFAULT_MODEL_ROUTE];
}

export class DshExecutorAdapter extends AcpExecutorAdapterBase {
  readonly executor_id = DSH_EXECUTOR_ID;
  readonly runtime_type = DSH_RUNTIME_TYPE;
  override readonly invocation_method = "acp stdio json-rpc (dsh --profile acp)";
  protected override readonly capability_ids = [...DSH_CAPABILITY_IDS];
  private readonly configuredEntry: string | null;

  constructor(
    deps: ConstructorParameters<typeof AcpExecutorAdapterBase>[0] & {
      dshEntry?: string;
    },
  ) {
    super(deps);
    this.configuredEntry = deps.dshEntry ?? null;
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

  protected override providerEnv(): Record<string, string> {
    const env: Record<string, string> = { DSH_TELEMETRY_DISABLED: "1" };
    const home = this.envOf("PAIR_DSH_HOME");
    if (home) env.DSH_HOME = home;
    // Donor parity: resolved credential pinned into child env; never evidence.
    const credName = this.credentialEnvNames()[0];
    const cred = this.envOf(credName);
    if (cred) env[credName] = cred;
    return env;
  }

  protected override credentialEnvNames(): string[] {
    const [provider] = modelRoute(this.envOf.bind(this));
    return provider === "deepseek-official" ? [DSH_OFFICIAL_CREDENTIAL_ENV] : [`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
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
    _task: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const [provider, model] = modelRoute(this.envOf.bind(this));
    const value = JSON.stringify([provider, model]);
    const resp = await proc.setConfigOption(sessionId, DSH_MODEL_CONFIG_ID, value, 30);
    return { model_route: [provider, model], model_config: { config_id: DSH_MODEL_CONFIG_ID, response: resp } };
  }
}
