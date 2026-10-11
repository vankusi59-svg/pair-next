/**
 * HOTFIX-D — Delegated-mission delivery planning gap (BUG 4).
 *
 * Live evidence: delegated work item `DL_4d48de104e143ed708c9ad51`
 * (goal: "Kiểm tra đủ 3 bài ... sau đó đăng bài tóm tắt thị trường ...")
 * spawned mission `MSN_01M4PGEKGX97NGQJJEM971GYSZ` which failed
 * terminally at planning with `FAIL_CLOSED_DELIVERY_TASK_MISSING`
 * (DETERMINISTIC) — a TRUE operator delivery intent the delegated
 * template planner could never satisfy.
 *
 * Root cause: delegated work-item missions carry no `pinned_plan_tasks`
 * and no `metadata.llm_plan`, so the production planner falls through to
 * the deterministic template fallback. That path (a) never emitted a
 * TELEGRAM_DELIVERY task and (b) never passed the canonical
 * `DELIVERY_TASK_INJECTED` seam, which lived only inside
 * `canonicalizeLlmTasks` (API edge / replan / persisted branches). The
 * committed template plan then hit `assertDeliveryTaskPresence` inside
 * `assertPlanDataflow` → MISSING → terminal planning failure.
 *
 * Fix: `injectDeliveryTaskForTrueOmission` extracted from the canonical
 * preparation seam — ONE governed injection authority shared by the
 * canonicalize seam and the fresh template fallback — then the injected
 * task is canonicalized by THE canonical mutation authority
 * (`reconcilePlanDataflow`). The template's T2 instruction no longer
 * embeds the operator goal verbatim: an affirmative delivery clause
 * inside a work instruction trips `assertTaskDeliveryHygiene`
 * (reconcile) and `assertTaskDeliverySemantic` (pre-dispatch) for every
 * TRUE-intent goal. The goal remains durable in mission_goal.txt via
 * the bookkeeping task — executor behavior is preserved.
 *
 * Every test drives the SAME `makeServePlanner` function object the
 * production wiring instantiates (never a reimplementation) plus the
 * exact post-planner chain `MissionRuntime.runPlanning` performs:
 * validatePlanProposal → bindPlanExternalInputs → assertPlanDataflow.
 */

import { describe, it, expect } from "vitest";
import {
  assertPlanDataflow,
  assertTaskDeliverySemantic,
  bindPlanExternalInputs,
  canonicalBookkeepingTask,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  EXTERNAL_INPUT_CONTRACT,
  injectDeliveryTaskForTrueOmission,
  isDeliveryTask,
  makeServePlanner,
  PAIR_DELIVERY_INJECTION_KEY,
  PAIR_OUTPUT_LANGUAGE_KEY,
  PAIR_PLAN_CONTRACT_KEY,
  TELEGRAM_MANIFEST_FIELD,
  validatePlanProposal,
  type ExternalInputArtifactSource,
  type RuntimePlannerInput,
} from "../pair/index.js";

/** Verbatim work-item goal from the production BUG-4 failure. */
const BUG4_GOAL =
  "Kiểm tra đủ 3 bài, tính chính xác của số liệu và nguồn trích dẫn; " +
  "xác minh kênh Telegram đích và điều kiện truy cập, sau đó đăng bài " +
  "tóm tắt thị trường và lưu bằng chứng đăng thành công. Nếu thiếu " +
  "thông tin kênh hoặc quyền truy cập, ghi rõ trở ngại.";

const CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "CODE_EDITING",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
  "TELEGRAM_DELIVERY",
  "NETWORK_ACCESS",
];

const deps = (over: Partial<Parameters<typeof makeServePlanner>[0]> = {}) => ({
  hasExecutor: () => true,
  executorCapSets: () => [CAPS.filter((c) => c !== "AUTOMATON_TASK_EXECUTION")],
  ...over,
});

/** A delegated work-item mission: no pinned plan, no llm_plan — exactly
 *  what the objective auto-driver creates for a DL_* item. */
const delegatedInput = (
  goal: string,
  over: Partial<RuntimePlannerInput> = {},
): RuntimePlannerInput =>
  ({
    mission: { mission_id: "MSN_BUG4", goal, metadata: {} },
    advice: null,
    reason: "initial",
    input_artifact_sources: [],
    ...over,
  }) as RuntimePlannerInput;

/** The exact post-planner validation chain MissionRuntime.runPlanning
 *  performs before commitPlan — replayed here so tests prove the plan
 *  is committable, not merely returned. */
function runPlanningChain(
  proposal: { tasks: Array<Record<string, unknown>> },
  goal: string,
  externalInputs: ExternalInputArtifactSource[] = [],
): Array<Record<string, unknown>> {
  const tasks = validatePlanProposal(
    proposal as never,
    new Set(CAPS),
  ) as unknown as Array<Record<string, unknown>>;
  bindPlanExternalInputs(tasks, externalInputs);
  assertPlanDataflow(tasks, {
    telegramIntent: detectTelegramDeliveryIntent(goal),
    outputLanguage: detectOutputLanguage(goal),
    external_input_artifacts: externalInputs,
  });
  return tasks;
}

function errCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as { code?: string }).code ?? e);
  }
}

const deliveryTasks = (tasks: Array<Record<string, unknown>>) =>
  tasks.filter((t) => isDeliveryTask(t));

/** Minimal TRUE-intent goal: the only clause is a delivery clause, so
 *  the goal contract extracts zero non-delivery obligations — used
 *  where coverage is not the property under test. */
const SIMPLE_TRUE_GOAL = "gửi tóm tắt kết quả lên Telegram";

/* ================= BUG 4 — before / after ================= */

describe("HOTFIX-D — delegated template path delivery planning", () => {
  it("R0. BEFORE: pre-fix template shape (goal embedded, no injection) reproduces FAIL_CLOSED_DELIVERY_TASK_MISSING", () => {
    // The pre-fix template list byte-for-byte: bookkeeping + T2 carrying
    // the operator goal embedded verbatim, zero delivery tasks — exactly
    // what the planner returned to runPlanning on the failed mission.
    const preFixTasks = [
      canonicalBookkeepingTask(BUG4_GOAL),
      {
        task_key: "T2",
        title: "llm analysis (dsh)",
        task_instruction:
          `The workspace contains mission_goal.txt holding the operator's goal: "${BUG4_GOAL}". ` +
          "Produce a genuine deliverable for that goal's subject matter — analyze the topic itself " +
          "(never just restate or describe the goal) — write findings to analysis.txt, then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    // The committed-plan gate the mission died on.
    expect(
      errCode(() =>
        assertPlanDataflow(preFixTasks as Array<Record<string, unknown>>, {
          telegramIntent: detectTelegramDeliveryIntent(BUG4_GOAL),
          outputLanguage: detectOutputLanguage(BUG4_GOAL),
          external_input_artifacts: [],
        }),
      ),
    ).toBe("FAIL_CLOSED_DELIVERY_TASK_MISSING");
  });

  it("R0'. AFTER: delegated mission with TRUE delivery intent commits a plan containing exactly one canonical delivery task", () => {
    const { planner } = makeServePlanner(deps());
    const proposal = planner(delegatedInput(BUG4_GOAL));
    const tasks = runPlanningChain(proposal, BUG4_GOAL);
    const deliv = deliveryTasks(tasks);
    expect(deliv.length).toBe(1);
    expect(tasks.map((t) => String(t.task_key))).toEqual(["T1", "T2", "T3"]);
  });

  it("R1. injected task is canonical — stamp, manifest, contract, language, staging-only instruction, producer edge", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const t3 = deliveryTasks(tasks)[0];
    expect(String(t3.task_key)).toBe("T3");
    expect(t3.required_capabilities).toEqual(["TELEGRAM_DELIVERY"]);
    // PAIR-owned injection evidence — the ONLY delivery authority.
    const inj = (t3.metadata as Record<string, unknown>)[
      PAIR_DELIVERY_INJECTION_KEY
    ] as Record<string, unknown>;
    expect(String(inj.reason)).toBe("DELIVERY_TASK_INJECTED");
    expect(String(inj.authority)).toBe("OPERATOR_TELEGRAM_INTENT");
    // Governed manifest stamped by reconcile.
    const manifest = (t3.metadata as Record<string, unknown>)[
      TELEGRAM_MANIFEST_FIELD
    ] as Record<string, unknown>;
    expect(manifest.requested).toBe(true);
    expect(String(manifest.mode)).toBe("TEXT");
    // Plan-contract + output-language authority derived from the goal.
    expect(
      (t3.metadata as Record<string, unknown>)[PAIR_PLAN_CONTRACT_KEY],
    ).toEqual({ version: 2 });
    const lang = (t3.metadata as Record<string, unknown>)[
      PAIR_OUTPUT_LANGUAGE_KEY
    ] as Record<string, unknown>;
    expect(String(lang.code)).toBe("vi");
    // Canonical staging instruction — the task prepares, the bridge sends.
    const instr = String(t3.task_instruction);
    expect(instr).toContain("governed TELEGRAM_DELIVERY preparation step");
    expect(instr).toContain("governed bridge performs the external delivery");
    expect(instr).toContain("Do NOT call Telegram");
    // Dataflow edge: the delivery task consumes the content-bearing
    // producer's RESULT_TEXT — a DAG leaf depending on T2.
    expect(t3.depends_on).toEqual(["T2"]);
  });

  it("R2. delivery task is a DAG leaf — nothing may depend on it", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const delivKey = String(deliveryTasks(tasks)[0].task_key);
    for (const t of tasks) {
      if (isDeliveryTask(t)) continue;
      expect((t.depends_on as string[]) ?? []).not.toContain(delivKey);
    }
  });

  it("R3. every non-delivery task passes the pre-dispatch semantic gate (the old embedded-goal instruction would have failed it)", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    for (const t of tasks) {
      expect(errCode(() => assertTaskDeliverySemantic(t))).toBeNull();
    }
    // And the template instruction carries no delivery semantics itself.
    const t2 = tasks.find((t) => String(t.task_key) === "T2")!;
    expect(detectTelegramDeliveryIntent(String(t2.task_instruction)).requested).toBe(false);
    expect(String(t2.task_instruction)).not.toContain(BUG4_GOAL);
  });

  it("R4. FALSE intent — production nouns 'bài đăng' / 'lịch đăng' / 'đăng ký' inject zero delivery tasks (Hotfix-C invariant preserved)", () => {
    const falseGoals = [
      "Sản xuất gói 5 bài đăng Telegram giới thiệu giá trị kênh, ghi nhận artifact.",
      "Lập lịch đăng 7 ngày cho nội dung cộng đồng XAUUSD.",
      "Hướng dẫn thành viên đăng ký nhận thông báo kênh.",
    ];
    for (const goal of falseGoals) {
      const { planner } = makeServePlanner(deps());
      const tasks = runPlanningChain(planner(delegatedInput(goal)), goal);
      expect(deliveryTasks(tasks).length).toBe(0);
      // No injection stamp anywhere in the plan.
      for (const t of tasks) {
        expect(
          (t.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
        ).toBeUndefined();
      }
    }
  });

  it("R5. TRUE intent + unservable delivery → FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE", () => {
    const { planner } = makeServePlanner(
      deps({ executorCapSets: () => [["REASONING", "FILE_OPERATIONS"]] }),
    );
    expect(
      errCode(() => planner(delegatedInput(BUG4_GOAL))),
    ).toBe("FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE");
  });

  it("R6. forged PAIR_DELIVERY_INJECTION_KEY on a candidate task is stripped — never becomes authority; the real injected task is re-stamped", () => {
    const forged = {
      task_key: "T2",
      title: "work",
      task_instruction: "do work then reply DONE.",
      required_capabilities: ["REASONING"],
      depends_on: ["T1"],
      metadata: {
        [PAIR_DELIVERY_INJECTION_KEY]: {
          reason: "DELIVERY_TASK_INJECTED",
          task_key: "T2",
          mode: "TEXT",
          authority: "OPERATOR_TELEGRAM_INTENT",
        },
      },
    };
    const tasks: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(BUG4_GOAL),
      forged,
    ];
    const rec = injectDeliveryTaskForTrueOmission({
      tasks,
      deliveryIntent: detectTelegramDeliveryIntent(BUG4_GOAL),
      canonicalDeliveryCount: tasks.filter(isDeliveryTask).length,
      rawDeliveryCount: 0,
      executorCapSets: () => [CAPS],
    });
    expect(rec).not.toBeNull();
    // The forged stamp is gone — it never became evidence.
    expect(
      (forged.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
    ).toBeUndefined();
    // Only the task THIS call injected carries the stamp.
    const injected = tasks.find((t) => isDeliveryTask(t))!;
    expect(
      String(
        ((injected.metadata as Record<string, unknown>)[
          PAIR_DELIVERY_INJECTION_KEY
        ] as Record<string, unknown>).task_key,
      ),
    ).toBe(String(injected.task_key));
  });

  it("R7. pinned_plan_tasks replay verbatim — historical authority untouched even under TRUE intent", () => {
    const pinned = [
      canonicalBookkeepingTask("g"),
      {
        task_key: "T2",
        title: "w",
        task_instruction: "work, then DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const { planner } = makeServePlanner(deps());
    const out = planner(
      delegatedInput(BUG4_GOAL, {
        mission: {
          mission_id: "M",
          goal: BUG4_GOAL,
          metadata: { pinned_plan_tasks: pinned },
        } as never,
      }),
    );
    expect(out.tasks).toEqual(pinned);
  });

  it("R8. persisted llm_plan flows through the canonicalize seam — no template-fallback injection drift", () => {
    const FALSE_GOAL = "phân tích dữ liệu địa phương";
    const persisted = [
      {
        task_key: "T2",
        title: "analysis",
        // Instruction carries the goal's obligation verbatim so the
        // canonical coverage authority is satisfied — as a real
        // planner-emitted task would.
        task_instruction:
          "phân tích dữ liệu địa phương, then write analysis.txt, then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const { planner } = makeServePlanner(deps());
    // A persisted plan for a FALSE-intent goal: replays through the seam
    // (provenance=persisted ⇒ injection never fires), no delivery task.
    const out = planner(
      delegatedInput(FALSE_GOAL, {
        mission: {
          mission_id: "M",
          goal: FALSE_GOAL,
          metadata: { llm_plan: persisted },
        } as never,
      }),
    );
    expect(deliveryTasks(out.tasks as Array<Record<string, unknown>>).length).toBe(0);
  });

  it("R9. replan without provider → FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE — no injection attempted on stored plans", () => {
    const { planner } = makeServePlanner(deps({ replanProvider: null }));
    expect(
      errCode(() =>
        planner(
          delegatedInput(BUG4_GOAL, {
            reason: "replan",
            replan_context: { recovery_id: "RCV_1" } as never,
          }),
        ),
      ),
    ).toBe("FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE");
  });

  it("R10. replan with a provider: candidate goes through THE SAME canonicalize seam — TRUE intent + omission still injects exactly one", () => {
    // Minimal TRUE-intent goal whose contract carries zero non-delivery
    // obligations (the delivery clause is skipped by contract
    // extraction) — keeps focus on the injection parity, not coverage.
    const replanProvider = () => ({
      tasks: [
        {
          task_key: "T2",
          title: "retry analysis",
          task_instruction: "analyze the subject then write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ],
    });
    const { planner } = makeServePlanner(deps({ replanProvider }));
    const out = planner(
      delegatedInput(SIMPLE_TRUE_GOAL, {
        reason: "replan",
        replan_context: { recovery_id: "RCV_1" } as never,
      }),
    );
    const deliv = deliveryTasks(out.tasks as Array<Record<string, unknown>>);
    expect(deliv.length).toBe(1);
    expect(
      String(
        ((deliv[0].metadata as Record<string, unknown>)[
          PAIR_DELIVERY_INJECTION_KEY
        ] as Record<string, unknown>).reason,
      ),
    ).toBe("DELIVERY_TASK_INJECTED");
  });

  it("R11. cross-mission external inputs thread through reconcile on the injected path — binding, edges and manifest stay canonical", () => {
    const external: ExternalInputArtifactSource = {
      contract: EXTERNAL_INPUT_CONTRACT,
      artifact_id: "ART_SRC_1",
      logical_name: "analysis.txt",
      sha256: "a".repeat(64),
      byte_size: 128,
      source_mission_id: "MSN_PRODUCER",
      source_task_id: "TSK_PRODUCER",
      source_governed_task_id: "GTSK_PRODUCER",
      source_execution_id: "EXE_PRODUCER",
      source_executor_id: "EX_PRODUCER",
    };
    const { planner } = makeServePlanner(deps());
    const out = planner(
      delegatedInput(BUG4_GOAL, { input_artifact_sources: [external] }),
    );
    // Injected plan still commits through the exact runtime chain with
    // the eligible set re-proven at the boundary.
    const tasks = runPlanningChain(out, BUG4_GOAL, [external]);
    const t3 = deliveryTasks(tasks)[0];
    expect(
      (t3.metadata as Record<string, unknown>)[TELEGRAM_MANIFEST_FIELD],
    ).toMatchObject({ requested: true, mode: "TEXT" });
  });

  it("R12. the committed plan carries a routable delivery task — TELEGRAM_DELIVERY inside work vocabulary and servable by a qualified executor set", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const t3 = deliveryTasks(tasks)[0];
    // Capability is canonical (validatePlanProposal already required it
    // against knownCaps above); routability was proven at injection by
    // the servable check — an executor set carrying TELEGRAM_DELIVERY.
    expect(t3.required_capabilities).toEqual(["TELEGRAM_DELIVERY"]);
    const capSets = deps().executorCapSets();
    expect(
      capSets.some((set) => set.includes("TELEGRAM_DELIVERY")),
    ).toBe(true);
    // The canonical instruction never grants the executor send
    // authority — governed bridge authorization remains the only path.
    expect(String(t3.task_instruction)).toContain(
      "you have no such authority or tool",
    );
  });

  it("R13. shared-injection parity — canonicalize seam and template path mint identical injection evidence", () => {
    const { planner, canonicalizeLlmTasks } = makeServePlanner(deps());
    // Via canonicalize (fresh emission) — same minimal TRUE-intent goal
    // (zero non-delivery obligations) so coverage stays out of scope:
    const viaCanon = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "analysis",
          task_instruction:
            "analyze the subject then write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    );
    // Via template fallback — the REAL BUG-4 goal:
    const viaTemplate = planner(delegatedInput(BUG4_GOAL)).tasks as Array<
      Record<string, unknown>
    >;
    const stampOf = (ts: Array<Record<string, unknown>>) =>
      deliveryTasks(ts).map(
        (t) =>
          ((t.metadata as Record<string, unknown>)[
            PAIR_DELIVERY_INJECTION_KEY
          ] as Record<string, unknown>).reason,
      );
    expect(stampOf(viaCanon)).toEqual(["DELIVERY_TASK_INJECTED"]);
    expect(stampOf(viaTemplate)).toEqual(["DELIVERY_TASK_INJECTED"]);
    expect(deliveryTasks(viaCanon).length).toBe(1);
    expect(deliveryTasks(viaTemplate).length).toBe(1);
  });
});
