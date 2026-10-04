/**
 * The production runtime planner composition used by
 * `scripts/serve-mission-control.mjs`.
 *
 * Lives in `src/pair` (not inline in the serve script) so the EXACT
 * production composition seam is importable and exercisable in tests —
 * a test drives the same `planner` function object production wiring
 * instantiates, never a reimplementation.
 *
 * F3 R1.1 — replan discipline:
 *   - `reason === "initial"` keeps the established behavior: confirmed
 *     `pinned_plan_tasks` verbatim → `metadata.llm_plan` through the
 *     canonicalize seam → deterministic template plan.
 *   - `reason === "replan"` NEVER silently replays a stored plan
 *     (pinned / llm_plan / unchanged template) as though it were a
 *     fresh alternative. A replan must come from a configured governed
 *     replan provider that receives the structured F3 `replan_context`;
 *     with none configured the planner throws
 *     `FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE`, which MissionRuntime
 *     treats as the REPLAN action itself being infeasible — recovery
 *     falls through to the RecoveryController's next bounded action.
 *
 *   The production LLM planner (`llmPlan`) is asynchronous and cannot
 *   run inside the synchronous `RuntimePlanner` contract, so production
 *   wiring passes no `replanProvider`: live production replanning is
 *   explicitly UNSUPPORTED under the current sync contract and REPLAN
 *   fails closed rather than replaying the old plan.
 */
import {
  isBookkeepingShapedTask,
  reservedAutomatonMisuseKey,
  resolveWorkTaskBudget,
  sanitizePlan,
  goalRequiresCurrentExternalData,
  taskRequiresNetworkAccess,
  instructionIsDataGathering,
} from "./llm-planner.js";
import {
  reconcilePlanDataflow,
  detectTelegramDeliveryIntent,
  CANONICAL_BOOKKEEPING_INSTRUCTION,
} from "./plan-dataflow.js";
import { detectOutputLanguage } from "./output-language.js";
import { IntegrityError } from "./errors.js";
import { DSH_EXECUTOR_ID } from "./dsh-adapter.js";
import { CODEX_EXECUTOR_ID } from "./codex-adapter.js";
import type { RuntimePlanner, RuntimePlannerInput } from "./mission-runtime.js";

/** Capability allowlist for LLM-derived plans (initial + replan). */
export const SERVE_LLM_PLANNER_CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "CODE_EDITING",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
  "TELEGRAM_DELIVERY",
  // PRV2-A R1.B — real routing fact: current/external-data tasks request
  // it; only an executor currently authorized for network access may
  // serve them (Codex live via CNI-1, Devin ambient governed network).
  "NETWORK_ACCESS",
];

/** PRV2-A R1.A — the model-visible WORK capability vocabulary: every
 *  capability a work task may request. AUTOMATON_TASK_EXECUTION is
 *  PAIR-reserved (it powers the injected bookkeeping task, which the
 *  model never authors) and is therefore NOT in this set. */
export const SERVE_LLM_WORK_CAPS = SERVE_LLM_PLANNER_CAPS.filter(
  (c) => c !== "AUTOMATON_TASK_EXECUTION",
);


/** PRV2-A §D — the PAIR-owned bookkeeping task: deterministic identity
 *  (T1, canonical instruction, canonical worker_spec carrying the goal as
 *  payload — never as an instruction the model could contaminate). */
export function canonicalBookkeepingTask(goal: string): Record<string, unknown> {
  return {
    task_key: "T1",
    title: "record mission goal",
    task_instruction: CANONICAL_BOOKKEEPING_INSTRUCTION,
    required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
    depends_on: [],
    metadata: {
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            {
              op: "write_text_file",
              path: "mission_goal.txt",
              content: goal,
              idempotency_class: "WRITE",
              risk_class: "MEDIUM",
            },
            {
              op: "finish",
              result: { summary: "goal recorded" },
              idempotency_class: "READ_ONLY",
              risk_class: "LOW",
            },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      },
    },
  };
}

export interface ServePlannerDeps {
  /** Whether a governed executor id is registered + qualified (template
   *  plan T2/T3 emission). Production: `(id) => governed.has(id)`. */
  hasExecutor: (executorId: string) => boolean;
  /** Capability sets of the currently-qualified executors — sanitizePlan
   *  drops tasks no single executor can serve. */
  executorCapSets: () => string[][];
  /** Optional SYNCHRONOUS governed replan provider. Receives the full
   *  RuntimePlannerInput including `replan_context`; its raw candidate
   *  still flows through the same canonicalize seam — no direct commit
   *  from provider output. Absent → REPLAN reports unavailability. */
  replanProvider?:
    | ((
        input: RuntimePlannerInput,
      ) => { tasks?: Array<Record<string, unknown>> } | null | undefined)
    | null;
}

/** THE ONE canonical LLM-plan preparation seam (Phase B R1 §7):
 *  sanitize + deterministic PAIR_NATIVE contract enrichment +
 *  dataflow reconcile — the failover winner-check, the pinned
 *  canonical_tasks, and the committed plan are the same list by
 *  construction. */
export function makeServeCanonicalizer(deps: {
  executorCapSets: () => string[][];
  /** PRV2-A §E — optional configured work-task ceiling (only tightens the
   *  derived adaptive budget; hard ceiling 12 always applies). */
  maxWorkTasks?: number;
}): (
  rawTasks: Array<Record<string, unknown>>,
  goal: string,
) => Array<Record<string, unknown>> {
  return (rawTasks, goal) => {
    // PRV2-A §D — the model emits WORK tasks only; PAIR owns bookkeeping.
    // A model-emitted bookkeeping-shaped task (filtered caps ⊆
    // {AUTOMATON_TASK_EXECUTION}) is deterministically normalized away so
    // the plan can never carry two bookkeeping authorities.
    const bookkeepingKeys = new Set<string>();
    // PRV2-A R1.A — reserved-capability misuse is a deterministic typed
    // reject: any task carrying AUTOMATON_TASK_EXECUTION that is not
    // pure-bookkeeping-shaped (a MIXED task, or a pure task with a
    // foreign worker_spec) can never become a canonical work task — no
    // stripping, no second bookkeeping worker_spec, no false-completion
    // path. The candidate fails PLAN_INVALID and failover proceeds.
    const misuseKey = reservedAutomatonMisuseKey(
      (rawTasks ?? []) as Array<Record<string, unknown>>,
    );
    if (misuseKey) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_RESERVED_CAPABILITY_AUTOMATON_TASK_EXECUTION",
        `task ${misuseKey} requests PAIR-reserved AUTOMATON_TASK_EXECUTION outside bookkeeping shape`,
      );
    }
    const workRaw = (rawTasks ?? []).filter((t) => {
      const shaped = isBookkeepingShapedTask(
        (t ?? {}) as Record<string, unknown>,
        SERVE_LLM_PLANNER_CAPS,
      );
      if (shaped) {
        const k = String((t as Record<string, unknown>)?.task_key ?? "");
        if (k) bookkeepingKeys.add(k);
      }
      return !shaped;
    });
    // PRV2-A §E — adaptive work-task budget bounds the work graph; the
    // injected bookkeeping task is not counted against it.
    const workBudget = resolveWorkTaskBudget(goal, deps.maxWorkTasks);
    const { tasks } = sanitizePlan(
      workRaw as never[],
      SERVE_LLM_WORK_CAPS,
      workBudget,
      deps.executorCapSets() as never[],
    );
    if (!tasks.length) return [] as Array<Record<string, unknown>>;
    // PRV2-A R2 — deterministic network-requirement authority at the
    // canonical seam (prompt wording is guidance, not authority):
    //  a) goal explicitly needs current/external data → the canonical work
    //     plan must contain a LEGITIMATE data-gathering task carrying
    //     NETWORK_ACCESS (fetch-shaped instruction — a dummy task carrying
    //     the capability does not count);
    //  b) a task whose instruction explicitly requests live/web fetching
    //     must itself carry NETWORK_ACCESS.
    // Neither rewrites the model's proposal — the candidate fails typed
    // and planner failover proceeds.
    if (goalRequiresCurrentExternalData(goal)) {
      const legitimate = tasks.some((t) => {
        const caps = (t.required_capabilities as string[] | undefined) ?? [];
        return (
          caps.includes("NETWORK_ACCESS") &&
          instructionIsDataGathering(String(t.task_instruction ?? ""))
        );
      });
      if (!legitimate) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED",
          "goal requires current/external data but no legitimate NETWORK_ACCESS data-gathering task",
        );
      }
    }
    for (const t of tasks) {
      const caps = (t.required_capabilities as string[] | undefined) ?? [];
      if (
        !caps.includes("NETWORK_ACCESS") &&
        taskRequiresNetworkAccess(String(t.task_instruction ?? ""))
      ) {
        throw new IntegrityError(
          "FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED",
          `task ${String(t.task_key)} requests live/web fetching without NETWORK_ACCESS`,
        );
      }
    }
    // PRV2-A §D — deterministic key/dependency remap: kept work tasks
    // become T2..T(n+1) in emitted order; a dependency on a dropped
    // bookkeeping-shaped task resolves to PAIR's injected T1.
    const keyMap = new Map<string, string>();
    tasks.forEach((t, i) => keyMap.set(String(t.task_key), `T${i + 2}`));
    const rawByKey = new Map(
      (rawTasks ?? []).map((t) => [
        String((t as Record<string, unknown>)?.task_key ?? ""),
        t as Record<string, unknown>,
      ]),
    );
    const workTasks = tasks.map((t) => {
      const raw = rawByKey.get(String(t.task_key));
      const rawDeps = Array.isArray(raw?.depends_on)
        ? (raw!.depends_on as unknown[]).map((d) => String(d))
        : [];
      const remapped = [
        ...(rawDeps.some((d) => bookkeepingKeys.has(d)) ? ["T1"] : []),
        ...(((t.depends_on as string[]) ?? [])
          .map((d) => keyMap.get(d))
          .filter((d): d is string => typeof d === "string")),
      ];
      return {
        ...t,
        task_key: keyMap.get(String(t.task_key))!,
        depends_on: [...new Set(remapped)],
      };
    });
    const tasksWithBookkeeping: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(String(goal ?? "")),
      ...workTasks,
    ];
    const allTasks = tasksWithBookkeeping;
    // PAIR_NATIVE tasks need an expected_output_contract worker_spec —
    // the LLM cannot emit one, so inject the canonical write-file
    // contract for any native-capability task that lacks it.
    for (const t of allTasks) {
      const caps = t.required_capabilities as string[];
      if (!caps.includes("AUTOMATON_TASK_EXECUTION")) continue;
      const md = (t.metadata ??= {}) as Record<string, unknown>;
      if (md.expected_output_contract) continue;
      md.expected_output_contract = {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            {
              op: "write_text_file",
              path: "mission_goal.txt",
              content: goal,
              idempotency_class: "WRITE",
              risk_class: "MEDIUM",
            },
            {
              op: "finish",
              result: { summary: "goal recorded" },
              idempotency_class: "READ_ONLY",
              risk_class: "LOW",
            },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      };
    }
    // Incident R1/R2 — deterministic artifact data-flow reconciliation
    // at THE canonical seam, before validatePlanProposal + plan_digest:
    // a task consuming an artifact must depend on its unique earlier
    // producer; unbound/ambiguous/backward producers throw
    // FAIL_CLOSED_PLAN_DATAFLOW_*. The telegram delivery authority is
    // the operator REQUEST alone.
    reconcilePlanDataflow(allTasks as never[], {
      telegramIntent: detectTelegramDeliveryIntent(String(goal ?? "")),
      outputLanguage: detectOutputLanguage(String(goal ?? "")),
    });
    return allTasks;
  };
}

/** Build the production runtime planner (the `planner` dep of
 *  MissionRuntime). See module docstring for the R1.1 replan
 *  discipline. */
export function makeServePlanner(deps: ServePlannerDeps): {
  planner: RuntimePlanner;
  canonicalizeLlmTasks: ReturnType<typeof makeServeCanonicalizer>;
} {
  const canonicalizeLlmTasks = makeServeCanonicalizer({
    executorCapSets: deps.executorCapSets,
  });
  const planner: RuntimePlanner = (input) => {
    const goal = String(input.mission.goal);
    if (input.reason === "replan") {
      // F3 R1.1 — a replan must be generated by a configured governed
      // provider consuming the structured failure context. Stored plans
      // (pinned_plan_tasks / metadata.llm_plan) and the deterministic
      // template are historical authority, never a "new" candidate —
      // replaying them would just spend the bounded candidate budget on
      // guaranteed duplicates. No provider configured → the REPLAN
      // action is explicitly unavailable (fail closed upstream).
      const provider = deps.replanProvider;
      if (provider) {
        const candidate = provider(input);
        const raw = candidate?.tasks;
        if (Array.isArray(raw) && raw.length) {
          try {
            const tasks = canonicalizeLlmTasks(raw, goal);
            if (tasks.length) return { tasks };
          } catch (err) {
            throw new IntegrityError(
              "FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE",
              `replan candidate failed canonicalization: ${
                String((err as { code?: string })?.code ?? "INVALID")
              }`,
            );
          }
        }
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE",
          "replan provider returned no viable candidate",
        );
      }
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE",
        "no governed synchronous replan provider configured",
      );
    }
    // Phase B pinned plan: a confirmed preview carries the EXACT
    // persisted canonical task list — return it verbatim
    // (validatePlanProposal re-validates; commitPlan pins the
    // manifest). The planner is never re-invoked for a pinned mission.
    const mdata = (input.mission?.metadata ?? {}) as Record<string, unknown>;
    const pinned = mdata.pinned_plan_tasks as unknown[] | undefined;
    if (Array.isArray(pinned) && pinned.length) {
      return { tasks: pinned as Array<Record<string, unknown>> };
    }
    const llm = mdata.llm_plan as unknown[] | undefined;
    if (Array.isArray(llm) && llm.length) {
      const tasks = canonicalizeLlmTasks(
        llm as Array<Record<string, unknown>>,
        goal,
      );
      if (tasks.length) return { tasks };
    }
    const tasks: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(goal),
    ];
    if (deps.hasExecutor(DSH_EXECUTOR_ID)) {
      tasks.push({
        task_key: "T2",
        title: "llm analysis (dsh)",
        task_instruction: `The workspace contains mission_goal.txt holding the operator's goal: "${goal}". Produce a genuine deliverable for that goal's subject matter — analyze the topic itself (never just restate or describe the goal) — write findings to analysis.txt, then reply DONE.`,
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      });
    }
    if (
      deps.hasExecutor(CODEX_EXECUTOR_ID) &&
      /codex|python|script|code/i.test(goal)
    ) {
      tasks.push({
        task_key: "T3",
        title: "codex step",
        task_instruction:
          "Create codex_out.txt in the workspace containing a short note implementing or summarizing the mission goal, then reply DONE.",
        required_capabilities: ["PYTHON_EXECUTION"],
        depends_on: ["T2"].filter((k) =>
          tasks.some((t) => t.task_key === k),
        ),
        metadata: {},
      });
    }
    return { tasks };
  };
  return { planner, canonicalizeLlmTasks };
}
