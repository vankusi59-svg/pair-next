/**
 * P-REASK — planner canonical-rejection feedback re-ask.
 *
 * Deterministic only — no live provider calls. llmPlan HTTP behavior is
 * proven with an injected fetchFn; codex behavior is proven at the pool
 * seam (invocation accounting) — the codex transport already performs
 * exactly one process invocation per codexPlannerPlan call by contract.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IntegrityError,
  runPlannerFailover,
  boundedAttemptWarnings,
  extractReaskEligibleCode,
  boundedReaskTaskWarnings,
  buildPlannerUserPrompt,
  llmPlan,
  beginPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  markPlannerAttemptReask,
  PairEvidenceStore,
  PLANNER_FAILURE_CLASS,
  type PlannerCandidate,
  type PlannerInvocation,
} from "../pair/index.js";

const cand = (id: string, ref = `p:${id}`): PlannerCandidate => ({
  model_entry_id: id, ref, provider: "p", model: id,
  endpoint: "https://example.test", credentialEnv: "ENV_X",
});
const codexCand = (id: string): PlannerCandidate => ({
  ...cand(id, `codex-cli:${id}`), transport: "codex_cli",
});

const okPlan = (label: string) => ({
  tasks: [
    {
      task_key: "T1",
      title: label,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
    },
  ],
  warnings: [] as string[],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("P-REASK — canonical-rejection feedback re-ask", () => {
  it("1. eligible typed PLAN rejection fires ONE re-ask with feedback", async () => {
    const calls: PlannerInvocation[] = [];
    const res = await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        calls.push(inv);
        return inv.kind === "REASK" ? okPlan("fixed") : okPlan("orig");
      },
      assertEligible: () => {},
      canonicalize: (tasks, _c) => {
        if (calls.length === 1) throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "coverage");
        return tasks;
      },
    });
    expect(calls.map((i) => i.kind)).toEqual(["INITIAL", "REASK"]);
    expect(calls[1].rejectionContext?.validation_code).toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(calls[1].maxProviderRequests).toBe(1);
    expect(res.winner.model_entry_id).toBe("A");
    expect(res.attempts).toHaveLength(1);
  });

  it("2. same candidate succeeds after correction; fallback never called", async () => {
    const seen: string[] = [];
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c, inv) => {
        seen.push(`${c.model_entry_id}:${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A" && !seen.includes("A:REASK")) {
          throw new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND", "dep");
        }
        return tasks;
      },
    });
    expect(seen).toEqual(["A:INITIAL", "A:REASK"]);
    expect(res.winner.model_entry_id).toBe("A");
  });

  it("3/5. rejectionContext carries ONLY the exact code + bounded task-keyed markers", async () => {
    let captured: PlannerInvocation | undefined;
    await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        if (inv.kind === "REASK") {
          captured = inv;
          return okPlan("f");
        }
        // Contaminated warnings: raw output text, exception detail, secret —
        // only task-keyed marker families may survive into feedback.
        return {
          tasks: [{ task_key: "T1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
          warnings: [
            "DROP_REMOTE_DEPENDENT:T3",
            "DEP_FORWARD_OR_UNKNOWN_PRUNED:T4",
            "REPAIRED_REMOTE_DEPENDENT_EDGE:T5",
            "raw model said: sk-live-SECRET_TOKEN_123 do this",
            "FAIL_CLOSED_PLAN_INCOMPLETE stack trace blah",
            "LLM_PLAN_NO_JSON",
            "TypeError: x is not a function at foo.js:12",
            "DROP_AMBIGUOUS_PRODUCER:T7",
          ],
        };
      },
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (!captured) throw new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_ORDER", "fwd dep");
        return tasks;
      },
    });
    expect(captured).toBeDefined();
    expect(captured!.rejectionContext?.validation_code).toBe("FAIL_CLOSED_PLAN_DATAFLOW_ORDER");
    expect(captured!.rejectionContext?.task_warnings).toEqual([
      "DROP_REMOTE_DEPENDENT:T3",
      "DEP_FORWARD_OR_UNKNOWN_PRUNED:T4",
      "REPAIRED_REMOTE_DEPENDENT_EDGE:T5",
      "DROP_AMBIGUOUS_PRODUCER:T7",
    ]);
  });

  it("4. prompt builder renders MINIMAL-REPAIR feedback, never defect content", async () => {
    const prompt = buildPlannerUserPrompt("goal x", {
      allowedCapabilities: ["FILE_OPERATIONS"],
      rejectionContext: {
        validation_code: "FAIL_CLOSED_PLAN_INCOMPLETE",
        task_warnings: ["DROP_A:T2", "DROP_B:T3"],
      },
    });
    expect(prompt).toContain("PLAN REJECTION");
    expect(prompt).toContain("validation_code: FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(prompt).toContain("DROP_A:T2, DROP_B:T3");
    expect(prompt).toContain("minimum change necessary");
    expect(prompt).toContain("Request no wider authority");
  });

  it("6/7. second canonical rejection settles once → failover; no recursive re-ask", async () => {
    const calls: string[] = [];
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c, inv) => {
        calls.push(`${c.model_entry_id}:${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
    });
    // A: INITIAL+REASK exactly (no third call — no recursion), B wins.
    expect(calls).toEqual(["A:INITIAL", "A:REASK", "B:INITIAL"]);
    expect(res.winner.model_entry_id).toBe("B");
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].attempt_no).toBe(1);
    expect(res.attempts[1].attempt_no).toBe(2);
  });

  it("second rejection with a DIFFERENT typed code preserves final identity", async () => {
    const recs: string[] = [];
    let aCalls = 0;
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => okPlan(inv.kind),
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") {
          aCalls++;
          throw new IntegrityError(
            aCalls === 1 ? "FAIL_CLOSED_PLAN_INCOMPLETE" : "FAIL_CLOSED_PLAN_DATAFLOW_ORDER",
            "x",
          );
        }
        return tasks;
      },
      onAttemptEnd: (_t, r) => recs.push(r.warnings.join("|")),
    });
    const w0 = recs[0];
    expect(w0).toContain("REASK:FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(w0).toContain("VALIDATION_CODE:FAIL_CLOSED_PLAN_DATAFLOW_ORDER");
    expect(w0).toContain("CANONICAL_VALIDATION_FAILED");
    expect(res.attempts[0].warnings.join("|")).toContain("REASK:FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("8. no re-ask on eligibility rejection", async () => {
    const calls: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => {
        calls.push(inv.kind);
        return okPlan("p");
      },
      assertEligible: (c) =>
        c.model_entry_id === "A"
          ? { reject: true, failure_class: PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE, reason: "stale" }
          : undefined,
      canonicalize: (t) => t,
    });
    expect(calls).toEqual(["INITIAL"]); // only B reached planFn (INITIAL); A never invoked
  });

  it("9. no re-ask on authority throw (code outside allowlist)", async () => {
    const calls: PlannerInvocation[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => {
        calls.push(inv);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") {
          throw new IntegrityError("FAIL_CLOSED_MISSION_ID_PUBLIC", "auth");
        }
        return tasks;
      },
    }).then((r) => r, () => null);
    expect(calls.map((i) => i.kind)).toEqual(["INITIAL", "INITIAL"]);
  });

  it("9b. non-IntegrityError throw → no re-ask", async () => {
    const calls: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => {
        calls.push(`${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") throw new Error("plain");
        return tasks;
      },
    });
    expect(calls).toEqual(["INITIAL", "INITIAL"]);
  });

  it("10. no re-ask for transport/timeout failures (planFn warnings, no plan)", async () => {
    const calls: string[] = [];
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c, inv) => {
        calls.push(inv.kind);
        return c.model_entry_id === "A"
          ? { tasks: [], warnings: ["LLM_PLANNER_REQUEST_TIMEOUT"] }
          : okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (t) => t,
    });
    expect(calls).toEqual(["INITIAL", "INITIAL"]);
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("11. NO_JSON/degenerate handled inside planFn — no pool-layer re-ask", async () => {
    const calls: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c, inv) => {
        calls.push(`${c.model_entry_id}:${inv.kind}`);
        return c.model_entry_id === "A"
          ? { tasks: [], warnings: ["LLM_PLAN_NO_JSON", "LLM_PLAN_DEGENERATE"] }
          : okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (t) => t,
    });
    expect(calls).toEqual(["A:INITIAL", "B:INITIAL"]);
  });

  it("12. llmPlan maxProviderRequests=1 → exactly ONE provider request", async () => {
    let fetches = 0;
    const res = await llmPlan("goal", {
      endpoint: "https://x.test/chat/completions",
      credentialEnv: "TEST_KEY",
      model: "m",
      allowedCapabilities: ["FILE_OPERATIONS"],
      maxProviderRequests: 1,
      env: { TEST_KEY: "k" } as never,
      fetchFn: (async () => {
        fetches++;
        // Degenerate response (no tasks) — would normally trigger the
        // internal retry; bounded to 1 call here.
        return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
      }) as never,
    });
    expect(fetches).toBe(1);
    expect(res.tasks).toEqual([]);
  });

  it("12b. default INITIAL contract still allows the internal retry (≤2)", async () => {
    let fetches = 0;
    const res = await llmPlan("goal", {
      endpoint: "https://x.test/chat/completions",
      credentialEnv: "TEST_KEY",
      model: "m",
      allowedCapabilities: ["FILE_OPERATIONS"],
      env: { TEST_KEY: "k" } as never,
      fetchFn: (async () => {
        fetches++;
        if (fetches === 1) {
          return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  tasks: [
                    { task_key: "T2", title: "w", task_instruction: "do real work then reply DONE", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
                  ],
                }),
              },
            }],
          }),
        };
      }) as never,
    });
    expect(fetches).toBe(2);
    expect(res.tasks.length).toBeGreaterThan(0);
  });

  it("13. REASK codex candidate = exactly one planFn invocation (kind=REASK, maxProviderRequests=1)", async () => {
    const calls: PlannerInvocation[] = [];
    const res = await runPlannerFailover({
      candidates: [codexCand("sol")],
      planFn: async (_c, inv) => {
        calls.push(inv);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (calls.length === 1) throw new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_ORDER", "x");
        return tasks;
      },
    });
    // One REASK invocation object; the codex transport performs exactly
    // one `codex exec` per call by contract — bounded here by
    // maxProviderRequests=1 as the shared contract marker.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: "REASK", maxProviderRequests: 1 });
    expect(res.winner.model_entry_id).toBe("sol");
  });

  it("14. internal-timeout → usable emission → canonical rejection: at most one further request", async () => {
    let fetches = 0;
    const invs: PlannerInvocation[] = [];
    const fetchFn = (async () => {
      fetches++;
      if (fetches === 1) throw new Error("abort"); // LLM_PLANNER_REQUEST_ERROR
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                tasks: [
                  { task_key: "T2", title: "w", task_instruction: "do work then reply DONE", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
                ],
              }),
            },
          }],
        }),
      };
    }) as never;
    const res = await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        invs.push(inv);
        return llmPlan("goal", {
          endpoint: "https://x.test/chat/completions",
          credentialEnv: "TEST_KEY",
          model: "m",
          allowedCapabilities: ["FILE_OPERATIONS"],
          env: { TEST_KEY: "k" } as never,
          fetchFn,
          maxProviderRequests: inv.maxProviderRequests,
          rejectionContext: inv.rejectionContext,
        });
      },
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (fetches === 2) throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
    });
    // INITIAL consumed 2 provider calls (error → degenerate → retry);
    // REASK consumed exactly ONE more — no extra layer retry.
    expect(fetches).toBe(3);
    expect(invs.map((i) => i.kind)).toEqual(["INITIAL", "REASK"]);
    expect(res.winner.model_entry_id).toBe("A");
  });

  it("15. latency ceiling: REASK timeout = min(requestTimeout, remaining)", async () => {
    let reask: PlannerInvocation | undefined;
    await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        if (inv.kind === "REASK") { reask = inv; return okPlan("p"); }
        await sleep(30); // burn part of the candidate budget
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (!reask) throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
      latencyBudget: () => ({ ceilingMs: 100, requestTimeoutMs: 60000 }),
    });
    expect(reask).toBeDefined();
    // remaining = 100 - elapsed(~30+) → effective timeout strictly < 100
    expect(reask!.timeoutMs).toBeLessThan(100);
    expect(reask!.timeoutMs).toBeGreaterThan(0);
  });

  it("16. exhausted remaining budget → NO re-ask", async () => {
    const calls: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => {
        calls.push(`${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
      latencyBudget: () => ({ ceilingMs: 0, requestTimeoutMs: 60000 }),
    });
    expect(calls).toEqual(["INITIAL", "INITIAL"]);
  });

  it("17. eligibility is re-proved before the second invocation", async () => {
    const seq: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        seq.push(`planFn:${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {
        seq.push("assertEligible");
      },
      canonicalize: (tasks) => {
        if (seq.filter((s) => s === "assertEligible").length === 1) {
          throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        }
        return tasks;
      },
    });
    expect(seq).toEqual(["assertEligible", "planFn:INITIAL", "assertEligible", "planFn:REASK"]);
  });

  it("17b. availability rejection at re-proof prevents the re-ask", async () => {
    const calls: string[] = [];
    let eligCalls = 0;
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (_c, inv) => {
        calls.push(inv.kind);
        return okPlan("p");
      },
      assertEligible: () => {
        eligCalls++;
        if (eligCalls === 2) {
          return { reject: true, failure_class: PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE, reason: "demoted" };
        }
      },
      canonicalize: (tasks, c) => {
        if (c.model_entry_id === "A") throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
    });
    expect(calls).toEqual(["INITIAL", "INITIAL"]); // A never re-asked
    expect(res.attempts[0].warnings.join("|")).toContain("ELIGIBILITY_REJECTED");
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("18/19/20. durable single-row REASK provenance — written BEFORE the second invocation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-preask-"));
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const run = beginPlannerRun(store, { routes: ["p:A"], actor: "PAIR_PLANNER" });
    const order: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => {
        order.push(`planFn:${inv.kind}`);
        if (inv.kind === "REASK") {
          // Simulate a crash: no settle — verify durable evidence exists.
          throw new Error("transport death");
        }
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks) => {
        throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
      },
      onAttemptStart: (base) => {
        order.push("attemptStart");
        return persistPlannerAttemptStart(store, {
          planner_run_id: String(run.planner_run_id),
          record: base,
          actor: "PAIR_PLANNER",
        }).planner_attempt_id;
      },
      onAttemptReask: (token, code) => {
        order.push(`markReask:${code}`);
        markPlannerAttemptReask(store, {
          planner_attempt_id: String(token),
          validation_code: code,
          actor: "PAIR_PLANNER",
        });
      },
      onAttemptEnd: (token, rec) => {
        order.push(`attemptEnd:${rec.outcome}`);
        settlePlannerAttempt(store, {
          planner_attempt_id: String(token),
          record: rec,
          actor: "PAIR_PLANNER",
        });
      },
    }).then(() => null, () => null);
    // One attempt row only; REASK marker durable; ordering proven.
    const rows = store.list("planner_attempt");
    expect(rows).toHaveLength(1);
    expect(order).toEqual([
      "attemptStart",
      "planFn:INITIAL",
      "markReask:FAIL_CLOSED_PLAN_INCOMPLETE",
      "planFn:REASK",
      "attemptEnd:FAILED",
    ]);
    const row = rows[0] as { warnings: string[]; outcome: string; planner_attempt_id: string };
    expect(row.warnings).toContain("REASK:FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(row.outcome).toBe("FAILED");
    // Lifecycle event evidence for the STARTED→STARTED re-ask.
    const events = store.listEvents("planner_attempt", row.planner_attempt_id).filter(
      (e) => String((e as { event_type?: string }).event_type) === "PLANNER_ATTEMPT_REASK_STARTED",
    );
    expect(events.length).toBe(1);
  });

  it("21. adversarial — >10 warnings before re-ask marker; protected provenance survives", async () => {
    const recs: string[][] = [];
    let canonCalls = 0;
    await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => ({
        tasks: [{ task_key: "T1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
        warnings: [
          ...Array.from({ length: 12 }, (_, i) => `DROP_ITEM_${i}:T${i}`),
          "REPAIRED_REMOTE_DEPENDENT_EDGE:T9",
        ],
      }),
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (canonCalls === 0) {
          canonCalls++;
          throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        }
        return tasks;
      },
      onAttemptEnd: (_t, r) => recs.push(r.warnings),
    });
    expect(recs).toHaveLength(1);
    const w = recs[0];
    expect(w.length).toBeLessThanOrEqual(10);
    expect(w).toContain("REASK:FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(w).toContain("REASK_SUCCEEDED:FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(w).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T9");
    // Deterministic replay: the exact combined input (both emissions'
    // warnings + provenance markers) yields the same bounded set.
    const replay = boundedAttemptWarnings([
      ...Array.from({ length: 12 }, (_, i) => `DROP_ITEM_${i}:T${i}`),
      "REPAIRED_REMOTE_DEPENDENT_EDGE:T9",
      ...Array.from({ length: 12 }, (_, i) => `DROP_ITEM_${i}:T${i}`),
      "REPAIRED_REMOTE_DEPENDENT_EDGE:T9",
      "REASK:FAIL_CLOSED_PLAN_INCOMPLETE",
      "REASK_SUCCEEDED:FAIL_CLOSED_PLAN_INCOMPLETE",
    ]);
    expect(replay).toEqual(w);
  });

  it("21b. winning-plan warnings describe the corrected emission only", async () => {
    let first = true;
    const res = await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async (_c, inv) => (
        inv.kind === "REASK"
          ? { tasks: okPlan("f").tasks, warnings: ["DROP_X:T1"] }
          : { tasks: okPlan("o").tasks, warnings: ["DROP_REJECTED:T2", "LLM_PLAN_NO_JSON"] }
      ),
      assertEligible: () => {},
      canonicalize: (tasks) => {
        if (first) {
          first = false;
          throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        }
        return tasks;
      },
    });
    // Winner metadata = corrected emission's warnings — rejected-plan
    // noise must not masquerade as winner provenance.
    expect(res.warnings).toEqual(["DROP_X:T1"]);
    expect(res.attempts[0].warnings.join("|")).toContain("REASK_SUCCEEDED:FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("22. F3 replanContext prompt unchanged; no rejection block without context", async () => {
    const base = buildPlannerUserPrompt("goal", {
      allowedCapabilities: ["FILE_OPERATIONS"],
    });
    expect(base).not.toContain("PLAN REJECTION");
    const replan = buildPlannerUserPrompt("goal", {
      allowedCapabilities: ["FILE_OPERATIONS"],
      replanContext: { failure_class: "DEPENDENCY_FAILURE" },
    });
    expect(replan).toContain("REPLAN CONTEXT");
    expect(replan).toContain("failure_class: DEPENDENCY_FAILURE");
    expect(replan).not.toContain("PLAN REJECTION");
  });

  it("23. candidate ordering unchanged: primary → fallback → extras", async () => {
    const seq: string[] = [];
    await runPlannerFailover({
      candidates: [cand("P"), cand("F"), cand("X")],
      planFn: async (c, inv) => {
        seq.push(`${c.model_entry_id}:${inv.kind}`);
        return okPlan("p");
      },
      assertEligible: () => {},
      canonicalize: (tasks, c) => {
        if (c.model_entry_id !== "X") throw new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x");
        return tasks;
      },
    });
    expect(seq).toEqual(["P:INITIAL", "P:REASK", "F:INITIAL", "F:REASK", "X:INITIAL"]);
  });

  it("helper: extractReaskEligibleCode only yields exact safe allowlisted codes", () => {
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_PLAN_INCOMPLETE", "x")))
      .toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_DELIVERY_TASK_MISSING", "x")))
      .toBe("FAIL_CLOSED_DELIVERY_TASK_MISSING");
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE", "x")))
      .toBe("FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE");
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_TASK_DELIVERY_SEMANTIC_MISMATCH", "x")))
      .toBe("FAIL_CLOSED_TASK_DELIVERY_SEMANTIC_MISMATCH");
    // Out of scope families → never eligible.
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_MISSION_ID_PUBLIC", "x"))).toBeNull();
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_PLANNER_EXHAUSTED", "x"))).toBeNull();
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_PLANNER_NO_ELIGIBLE", "x"))).toBeNull();
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE", "x"))).toBeNull();
    expect(extractReaskEligibleCode(new IntegrityError(`FAIL_CLOSED_PLAN_${"X".repeat(90)}`, "x"))).toBeNull();
    expect(extractReaskEligibleCode(new IntegrityError("FAIL_CLOSED_PLAN bad", "x"))).toBeNull();
    expect(extractReaskEligibleCode(new Error("x"))).toBeNull();
    expect(extractReaskEligibleCode("FAIL_CLOSED_PLAN_INCOMPLETE")).toBeNull();
  });
});
