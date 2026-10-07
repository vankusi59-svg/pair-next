/**
 * Planner prompt ↔ canonical-gate contract tests (live incident M3/M4).
 *
 * Background: the codex-cli planner emitted schema-valid plans that the
 * canonical validator kept rejecting — (a) task instructions named hosts
 * the goal never authorized (github.com, tradingview.com,
 * mql5.com) → FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID /
 * UNAUTHORIZED_SOURCE, and (b) a non-delivery task echoed the goal's
 * Telegram wish into its instruction ("...để gửi report.md qua
 * Telegram") → FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK.
 *
 * Root cause audited: SYSTEM_PROMPT over-granted — "EXTERNAL SOURCE
 * CHOICE" told the model it "may and should name an appropriate real
 * source" for hostless goals and "CURRENT/EXTERNAL DATA" demanded the
 * task "name the real source", while the gate only tolerates
 * instruction-named hosts when the GOAL literally names them or demands
 * external data (a keyword detector the model cannot evaluate). The
 * prompt also never forbade delivery verbs inside non-delivery tasks.
 *
 * This file pins the corrected contract. T1–T5 and the re-ask tests are
 * non-vacuous: every one of them fails on the pre-fix prompt. T6 and the
 * control case are regression guards that must pass before AND after.
 */
import { describe, expect, it } from "vitest";
import { buildPlannerUserPrompt, plannerSystemPrompt } from "../pair/llm-planner.js";

const PROMPT = plannerSystemPrompt();

const ALLOWED_CAPS = [
  "FILE_OPERATIONS",
  "REASONING",
  "NETWORK_ACCESS",
  "TELEGRAM_DELIVERY",
  "REMOTE_CLOUD_TASK_EXECUTION",
];

function rejectedPrompt(validation_code: string): string {
  return buildPlannerUserPrompt("nghiên cứu giá vàng hôm nay", {
    allowedCapabilities: ALLOWED_CAPS,
    rejectionContext: {
      validation_code,
      detail: `${validation_code}:{"task":"T1"}`,
      task_warnings: [validation_code],
    },
  });
}

describe("planner prompt contract — network authority (M3/M4 RC1)", () => {
  it("T1: instruction may name a hostname/URL only when the goal literally authorizes it", () => {
    expect(PROMPT).toMatch(/only when the goal literally names that host/i);
    expect(PROMPT).toMatch(/never invent a hostname\/URL/i);
  });

  it("T2: old over-grant wording is gone from BOTH source bullets", () => {
    // EXTERNAL SOURCE CHOICE previously said the planner "may and should
    // name an appropriate real source" for hostless goals.
    expect(PROMPT).not.toMatch(/may and should name an appropriate real source/i);
    // CURRENT/EXTERNAL DATA previously demanded the task "name the real
    // source" — the equivalent over-grant in the second bullet.
    expect(PROMPT).not.toMatch(/name the real source/i);
  });

  it('T3: "owner/repo" is not a hostname — preserve the repo reference, never expand to a URL', () => {
    expect(PROMPT).toMatch(/owner\/repo/i);
    expect(PROMPT).toMatch(/not a hostname/i);
    expect(PROMPT).toMatch(/never expand it into a URL/i);
  });
});

describe("planner prompt contract — delivery hygiene (M4 RC2)", () => {
  it("T4: only TELEGRAM_DELIVERY tasks may carry affirmative Telegram delivery directives", () => {
    expect(PROMPT).toMatch(/only a task carrying TELEGRAM_DELIVERY may contain/i);
    expect(PROMPT).toMatch(/non-delivery task/i);
  });

  it("T5: purpose clauses count — producers produce, delivery intent lives in depends_on", () => {
    // The M4 re-ask kept the delivery intent as a purpose clause
    // ("...để gửi report.md qua Telegram") — the rule must cover purpose
    // clauses, not just direct imperatives.
    expect(PROMPT).toMatch(/purpose clause/i);
    expect(PROMPT).toMatch(/delivery relationship is expressed only through depends_on/i);
    // TELEGRAM_DELIVERY's own rule still exists (T6 checks in full).
    expect(PROMPT).toMatch(/TELEGRAM_DELIVERY/);
  });
});

describe("planner prompt contract — dataflow/coverage gaps seen live (R1 round 2)", () => {
  const goalNamedBullet = () =>
    PROMPT.match(/GOAL-NAMED FILE DELIVERABLES[^\n]*/i)?.[0] ?? "";

  it("R1.A — real named deliverable still requires a producer with the exact filename", () => {
    const b = goalNamedBullet();
    expect(b).toMatch(/GOAL-NAMED/i);
    expect(b).toMatch(/output\/deliverable|deliverable/i);
    expect(b).toMatch(/some task must produce that exact filename/i);
    expect(b).toMatch(/outbox endpoint/i);
  });

  it("R1.B — modify/edit/fix of a source file does NOT by itself make it a deliverable", () => {
    const b = goalNamedBullet();
    expect(b).toMatch(/modif|edit|fix/i);
    expect(b).toMatch(/does not|never|not by itself/i);
    // the over-broad "create or modify => PRODUCE" overstatement is gone
    expect(b).not.toMatch(/create or modify/i);
  });

  it("R1.C — remote artifact handoff invariants survive the narrowing", () => {
    const b = goalNamedBullet();
    expect(b).toMatch(/remote/i);
    expect(PROMPT).toMatch(/REMOTE DATAFLOW CONTRACT/);
    expect(PROMPT).toMatch(/BYTE DEPENDENCIES/);
    expect(PROMPT).toMatch(/TELEGRAM_DELIVERY/);
  });

  it("one path per artifact: no restating the same file under a different path form or verb", () => {
    expect(PROMPT).toMatch(/ONE PATH PER ARTIFACT/);
    expect(PROMPT).toMatch(/ONE consistent path/i);
    expect(PROMPT).toMatch(/consume edge with no earlier producer fails canonical validation/i);
  });
});

describe("planner prompt contract — re-ask guidance", () => {
  it("rejection FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID gets host-removal guidance", () => {
    const p = rejectedPrompt("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(p).toMatch(/remove every hostname\/URL the goal does not literally authorize/i);
    expect(p).toMatch(/host-free/i);
  });

  it("rejection FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK gets verb-removal guidance", () => {
    const p = rejectedPrompt("FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK");
    expect(p).toMatch(/remove the Telegram send\/delivery directive/i);
    expect(p).toMatch(/exclusively to the TELEGRAM_DELIVERY task/i);
  });

  it("R2.A: FAIL_CLOSED_PLAN_INCOMPLETE keeps generic minimal-repair, NO missing-file diagnosis", () => {
    // PLAN_INCOMPLETE is a generic coverage failure (missing obligation,
    // legitimate deliverable, quantity mismatch — or a Goal Contract
    // false-positive like M3's DEL_001). The prompt must not self-diagnose
    // it as a missing file producer.
    const p = rejectedPrompt("FAIL_CLOSED_PLAN_INCOMPLETE");
    expect(p).toMatch(/minimum change necessary to fix the named defect/i);
    // The absence assertions scope to the rejection section: the GOAL
    // CONTRACT block's generic coverage line ("every deliverable needs a
    // task that produces the exact named file") is canonical semantics
    // present in every prompt — not a PLAN_INCOMPLETE-specific diagnosis.
    const rejection = p.slice(p.indexOf("PLAN REJECTION"));
    expect(rejection).not.toMatch(/goal-named file\/deliverable has no producing task/i);
    expect(rejection).not.toMatch(/produces the exact named file/i);
    expect(rejection).not.toMatch(/outbox endpoint/i);
    expect(rejection).not.toMatch(/Specific fix:/i);
  });

  it("rejection FAIL_CLOSED_PLAN_DATAFLOW_* gets consistent-path guidance", () => {
    const p = rejectedPrompt("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
    expect(p).toMatch(/ONE consistent path per artifact/i);
    const p2 = rejectedPrompt("FAIL_CLOSED_PLAN_DATAFLOW_ORDER");
    expect(p2).toMatch(/ONE consistent path per artifact/i);
  });

  it("control: unrelated validation codes keep only the generic minimal-repair guidance", () => {
    const p = rejectedPrompt("FAIL_CLOSED_SOME_OTHER_CODE");
    expect(p).toMatch(/minimum change necessary to fix the named defect/i);
    expect(p).not.toMatch(/remove every hostname\/URL/i);
    expect(p).not.toMatch(/remove the Telegram send\/delivery directive/i);
  });
});

describe("planner prompt contract — regression invariants (T6)", () => {
  it("operator-named host must be used exactly — no source substitution", () => {
    expect(PROMPT).toMatch(/substitute/i);
  });

  it("TELEGRAM_DELIVERY stays a separate DAG-leaf task when explicitly requested", () => {
    expect(PROMPT).toMatch(/DAG-leaf task with capability TELEGRAM_DELIVERY/i);
  });

  it("REMOTE DATAFLOW CONTRACT still present", () => {
    expect(PROMPT).toMatch(/REMOTE DATAFLOW CONTRACT/);
  });

  it("BYTE DEPENDENCIES still present", () => {
    expect(PROMPT).toMatch(/BYTE DEPENDENCIES/);
  });

  it('planner still forbidden from emitting "network_requirement"', () => {
    expect(PROMPT).toMatch(/Do NOT emit "network_requirement"/);
  });

  it("planner never names an executor directly", () => {
    expect(PROMPT).toMatch(/you never name an executor/i);
  });

  it("PAIR/runtime still decides actual network permission", () => {
    expect(PROMPT).toMatch(/PAIR and runtime policy still decide actual network permission/i);
  });
});
