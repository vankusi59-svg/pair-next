/**
 * DshExecutorAdapter — governed DeepSeek Harness executor (ACP_STDIO).
 *
 * Port of donor deepseek_harness_acp.py (a557df2): launch `dsh --profile acp`,
 * pinned DSH_HOME, credential env resolvable but never read into evidence,
 * model route pinned through session/set_config_option. Capabilities are
 * reported only after live qualification — an unqualified DSH is never
 * eligible.
 *
 * Phase C — governed DSH model routing: when a `dshModelRouter` is bound
 * (late-bound at serve wiring, after model_binding rows are minted), the
 * adapter executes the ROUTER-SELECTED model per attempt:
 *   - `providerEnv` resolves the credential of the selected provider only —
 *     a missing credential env is a pre-dispatch availability failure,
 *     never a fallback to the primary's credential;
 *   - `postSessionSetup` pins session/set_config_option("model") to exactly
 *     the attempt's candidate [provider, model] after re-asserting role
 *     authority — the pinned model equals the attempt evidence verbatim;
 *   - `runAttempts` runs configured-order failover inside ONE execution,
 *     bounded by the task's shared deadline, only while dispatch_state is
 *     PRE_DISPATCH — post-dispatch uncertainty never retries a next model.
 * Without a router the legacy env path (PAIR_DSH_MODEL_ROUTE →
 * DSH_DEFAULT_MODEL_ROUTE) remains as a compatibility/probe fallback; it
 * grants no runtime model authority inside the governed path.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  AcpExecutorAdapterBase,
  type AcpAttemptContext,
  type ExecutionRecord,
} from "./acp-executor.js";
import type { AcpPermissionBroker } from "./acp-permissions.js";
import type { AcpLaunch, AcpProcess } from "./acp-transport.js";
import { PairError } from "./errors.js";
import {
  dshModelExhaustedError,
  DSH_ATTEMPT_ENTITY,
  type DshModelCandidate,
  type DshModelRouter,
} from "./dsh-model-router.js";
import type { PairControlPlane } from "./service.js";

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

export function modelRoute(env: (n: string) => string | undefined): [string, string] {
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
  private readonly roleAssertion: ((provider: string, model: string) => void) | null;
  private dshModelRouter: DshModelRouter | null = null;
  private serviceRef: PairControlPlane | null = null;

  constructor(
    deps: ConstructorParameters<typeof AcpExecutorAdapterBase>[0] & {
      dshEntry?: string;
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
    this.roleAssertion = deps.modelRoleAssertion ?? null;
  }

  /**
   * Phase C: bind the governed DSH model router after model_binding rows
   * exist (serve wiring runs the qualify loop before this). From here on
   * the router is the only model authority for dispatched work.
   */
  bindModelRouter(router: DshModelRouter, service: PairControlPlane): void {
    this.dshModelRouter = router;
    this.serviceRef = service;
  }

  private envOf(name: string): string | undefined {
    return (this.deps.envReader ?? ((n) => process.env[n]))(name);
  }

  /** The model this attempt pins: router candidate when governed, else the
   *  legacy env fallback (probe/compat path only). */
  private selectedModel(attemptCtx?: AcpAttemptContext): {
    provider: string;
    model: string;
    governed: boolean;
  } {
    const cand = attemptCtx?.candidate as DshModelCandidate | null | undefined;
    if (cand?.pid && cand.mid) {
      return { provider: cand.pid, model: cand.mid, governed: true };
    }
    const [provider, model] = modelRoute(this.envOf.bind(this));
    return { provider, model, governed: false };
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

  /** Minimal provider env pins — never the full process env. The credential
   *  follows the attempt's selected provider. */
  protected override providerEnv(attemptCtx?: AcpAttemptContext): Record<string, string> {
    const env: Record<string, string> = { DSH_TELEMETRY_DISABLED: "1" };
    const home = this.envOf("PAIR_DSH_HOME");
    if (home) env.DSH_HOME = home;
    // Donor parity: resolved credential pinned into child env; never evidence.
    const sel = this.selectedModel(attemptCtx);
    const credName = this.credentialEnvNamesFor(sel.provider)[0];
    const cred = this.envOf(credName);
    if (cred) env[credName] = cred;
    return env;
  }

  /** Probe-path credential name — selected provider of the env fallback
   *  (the router has no notion of a probe attempt). */
  protected override credentialEnvNames(): string[] {
    const [provider] = modelRoute(this.envOf.bind(this));
    return this.credentialEnvNamesFor(provider);
  }

  private credentialEnvNamesFor(provider: string): string[] {
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

  /** Credential presence for the SELECTED candidate's provider — missing
   *  env is an availability failure (safe pre-dispatch), never satisfied by
   *  another provider's credential. */
  private credentialAvailable(provider: string): boolean {
    return this.credentialEnvNamesFor(provider).some((n) => Boolean(this.envOf(n)));
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
      dsh_model_pool: this.dshModelRouter
        ? this.dshModelRouter.candidates().map((c) => ({
            ref: c.ref,
            provider_id: c.pid,
            model_entry_id: c.model_entry_id,
          }))
        : null,
    };
  }

  /** Provider post-session pinning — ALWAYS executes; the selected model is
   *  re-asserted immediately before dispatch (safe side of the side-effect
   *  boundary). When the router governed the attempt, the pinned model must
   *  equal the attempt evidence exactly. */
  protected override async postSessionSetup(
    proc: AcpProcess,
    sessionId: string,
    _session: Record<string, unknown>,
    _features: Record<string, unknown>,
    _task: Record<string, unknown>,
    attemptCtx?: AcpAttemptContext,
  ): Promise<Record<string, unknown>> {
    const sel = this.selectedModel(attemptCtx);
    // Runtime role enforcement: the model about to execute DSH work must be
    // canonically authorized as DSH_EXECUTION (Planner pool is disjoint).
    this.roleAssertion?.(sel.provider, sel.model);
    const value = JSON.stringify([sel.provider, sel.model]);
    const resp = await proc.setConfigOption(sessionId, DSH_MODEL_CONFIG_ID, value, 30);
    return {
      model_route: [sel.provider, sel.model],
      model_governed: sel.governed,
      model_config: { config_id: DSH_MODEL_CONFIG_ID, response: resp },
    };
  }

  /* -------------------------------------------------- Phase C failover -- */

  /**
   * Governed model failover inside ONE governed dispatch/execution.
   * Configured order is authoritative; eligibility is re-proved before
   * EVERY attempt; authority failures throw and never failover;
   * availability failures may move to the next candidate. The task timeout
   * is a single shared deadline across all candidates — a later candidate
   * only gets the remainder. After the prompt dispatch boundary a failure
   * exits through the standard runtime/recovery taxonomy.
   */
  protected override async runAttempts(
    rec: ExecutionRecord,
    task: Record<string, unknown>,
    launch: AcpLaunch,
    prompt: string,
    before: Record<string, unknown>,
    broker: AcpPermissionBroker,
    updatesLog: string,
    decisionsLog: string,
  ): Promise<void> {
    const router = this.dshModelRouter;
    if (!router) {
      await this.attemptExecution(rec, task, launch, prompt, before, broker, updatesLog, decisionsLog, undefined);
      return;
    }
    const timeoutSeconds = Number(task.timeout ?? this.deps.timeoutSeconds ?? 300);
    const deadlineMs = Date.now() + timeoutSeconds * 1000;
    let attemptNo = 0;

    for (const candidate of router.candidates()) {
      // Shared deadline — never start a candidate with no budget left.
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        const token = this.persistAttempt(candidate, task, rec, attemptNo + 1);
        router.attemptEnd(token, {
          outcome: "FAILED",
          failure_class: "TIMEOUT",
          error_code: "ACP_REQUEST_TIMEOUT",
          safe_to_failover: false,
        });
        throw new PairError(
          "ACP_REQUEST_TIMEOUT",
          `DSH shared task deadline exhausted before attempt ${attemptNo + 1} (${candidate.ref})`,
        );
      }
      attemptNo += 1;
      const token = this.persistAttempt(candidate, task, rec, attemptNo);
      // Eligibility re-proved before every invocation. Authority failures
      // THROW — the attempt row already exists so the rejection is durable
      // evidence; they are never a failover signal.
      let eligible: ReturnType<DshModelRouter["assertEligible"]>;
      try {
        eligible = router.assertEligible(candidate);
      } catch (error) {
        router.attemptEnd(token, {
          outcome: "FAILED",
          failure_class: "TRANSIENT_TRANSPORT",
          error_code: String((error as { code?: string })?.code ?? "AUTHORITY"),
          safe_to_failover: false,
        });
        throw error;
      }
      if (eligible?.reject) {
        router.attemptEnd(token, {
          outcome: "FAILED",
          failure_class: eligible.failure_class,
          error_code: eligible.reason,
          safe_to_failover: true,
        });
        continue;
      }
      // Credential follows the selected model's provider — never reuse the
      // primary's credential on a fallback.
      if (!this.credentialAvailable(candidate.pid)) {
        router.attemptEnd(token, {
          outcome: "FAILED",
          failure_class: "CREDENTIAL_MISSING",
          error_code: "CREDENTIAL_ENV_MISSING",
          safe_to_failover: true,
        });
        continue;
      }
      const attemptCtx: AcpAttemptContext = {
        candidate: candidate as unknown as Record<string, unknown>,
        remainingSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        markDispatch: () => router.markDispatched(token),
      };
      try {
        await this.attemptExecution(
          rec, task, launch, prompt, before, broker, updatesLog, decisionsLog, attemptCtx,
        );
        router.attemptEnd(token, {
          outcome: "SUCCESS",
          safe_to_failover: false,
          winner: true,
        });
        return;
      } catch (error) {
        // Authority throw inside the attempt (e.g. role assertion) — settle
        // the attempt and propagate; never a failover signal.
        if (error instanceof PairError && /^FAIL_CLOSED/.test(error.code)) {
          router.attemptEnd(token, {
            outcome: "FAILED",
            failure_class: "TRANSIENT_TRANSPORT",
            error_code: error.code,
            safe_to_failover: false,
          });
          throw error;
        }
        const cls = router.classifyError(error, token.dispatched);
        router.attemptEnd(token, {
          outcome: "FAILED",
          failure_class: cls.failure_class,
          error_code: String((error as { code?: string })?.code ?? error),
          safe_to_failover: cls.safe_to_failover,
        });
        if (!cls.safe_to_failover) throw error; // post-dispatch / uncertain
        continue;
      }
    }
    // Every configured candidate failed pre-dispatch or none was eligible:
    // fail closed with the durable attempt evidence — never a hidden
    // default, never a Planner model, never an unconfigured model.
    throw dshModelExhaustedError(this.attemptRowsFor(rec.governed_task_id));
  }

  private persistAttempt(
    candidate: DshModelCandidate,
    task: Record<string, unknown>,
    rec: ExecutionRecord,
    attemptNo: number,
  ) {
    let routeId: string | null =
      (task.route_id as string | undefined) ??
      (task.selected_route_id as string | undefined) ??
      null;
    let supplyBindingId: string | null =
      (task.route_binding_id as string | undefined) ??
      (task.binding_id as string | undefined) ??
      null;
    if ((!routeId || !supplyBindingId) && this.serviceRef && task.task_id) {
      try {
        const parent = this.serviceRef.store.get("task", String(task.task_id)) as
          | Record<string, unknown>
          | undefined;
        routeId = routeId ?? (parent?.selected_route_id as string | undefined) ?? null;
        supplyBindingId =
          supplyBindingId ?? (parent?.binding_id as string | undefined) ?? null;
      } catch {
        /* parent task row absent in this context — linkage stays null */
      }
    }
    return this.dshModelRouter!.attemptStart({
      candidate,
      governed_task_id: String(rec.governed_task_id),
      mission_id: String(task.mission_id ?? ""),
      task_id: String(task.task_id ?? ""),
      correlation_id: String(task.correlation_id ?? ""),
      route_id: routeId,
      executor_supply_binding_id: supplyBindingId,
      execution_id: rec.execution_id,
      attempt_no: attemptNo,
    });
  }

  private attemptRowsFor(governedTaskId: string): Array<Record<string, unknown>> {
    if (!this.serviceRef) return [];
    return (this.serviceRef.store.list(DSH_ATTEMPT_ENTITY) as Array<Record<string, unknown>>).filter(
      (r) => String(r.governed_task_id) === String(governedTaskId),
    );
  }

}
