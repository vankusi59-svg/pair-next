/**
 * R3 — operator-side authorization is explicit-host ONLY (audit
 * remediation of the R2 identity over-grant).
 *
 * Closed flaw: `extractGoalIdentities` + label-membership matching turned
 * entity tokens (MQL5, BTC, 144, OpenAI) into source authorization —
 * `mql5.attacker.example` / `144.attacker.example` were authorized by a
 * goal merely naming the entity, and dotted file tokens (`math.txt`)
 * became goal-hosts. R3: the ONLY authorization surface is a hostname or
 * URL the operator goal literally writes (exact or DNS-label-boundary
 * subdomain; no widening when a subdomain is named).
 *
 * Adversarial matrix A–K per mandate. A/B/C/D/G traverse the real
 * production path (llmPlan sanitize → repairNetworkCapabilityBinding →
 * makeServeCanonicalizer) and the codex transport where applicable.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { llmPlan, repairNetworkCapabilityBinding } from "../pair/llm-planner.js";
import { codexPlannerPlan } from "../pair/codex-planner.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import {
  extractGoalHosts,
  goalAuthorizesHost,
  requirementLocatorHost,
  resolveTaskNetworkAuthority,
  type NetworkRequirement,
} from "../pair/network-requirement.js";
import { IntegrityError } from "../pair/errors.js";

const CAP_SETS = [
  ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS", "CODE_GENERATION", "TELEGRAM_DELIVERY"],
];
const ALLOWED = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "NETWORK_ACCESS",
  "TELEGRAM_DELIVERY",
];
const CFG = {
  endpoint: "https://example.invalid/chat/completions",
  credentialEnv: "TEST_LLM_KEY",
  model: "test-model",
  allowedCapabilities: ALLOWED,
  capabilitySets: CAP_SETS,
  env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
  timeoutMs: 5_000,
};

const canon = (
  raw: Array<Record<string, unknown>>,
  goal: string,
  provenance?: "fresh" | "persisted",
) =>
  makeServeCanonicalizer({ executorCapSets: () => CAP_SETS })(
    raw,
    goal,
    provenance ? { provenance } : undefined,
  );

const planJson = (tasks: Array<Record<string, unknown>>) =>
  JSON.stringify({ tasks });
const okFetch = (content: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

const LOCAL_REQ: NetworkRequirement = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
};
const extReq = (locator: string): NetworkRequirement => ({
  source_kind: "EXTERNAL_SITE",
  access_intent: "RESEARCH",
  freshness: "REQUIRED",
  source_locator: locator,
});

/** Raw planner emission of one fetch task (top-level requirement form). */
const emitFetchTask = (
  locator: string,
  caps: string[] = ["REASONING"],
  instruction?: string,
): Record<string, unknown> => ({
  task_key: "T2",
  title: "T2",
  task_instruction:
    instruction ??
    `Fetch the latest data from ${locator} and write notes to notes.md.`,
  required_capabilities: caps,
  depends_on: [],
  pair_coverage: ["OBL_001"],
  network_requirement: extReq(locator),
});

interface CanonFail {
  code: string;
  detail: string;
}
const canonFail = (fn: () => unknown): CanonFail | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof IntegrityError) {
      return { code: e.code ?? "?", detail: e.message };
    }
    return { code: "NON_INTEGRITY", detail: String(e) };
  }
};

/** Fake codex executable emitting a fixed plan (transport parity). */
const fakeCodex = (dir: string, tasks: Array<Record<string, unknown>>) => {
  const exe = path.join(dir, "fake-codex.cjs");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--output-last-message") + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  fs.writeFileSync(out, JSON.stringify({ tasks: ${JSON.stringify(tasks)} }));
  process.exit(0);
});
`,
  );
  fs.chmodSync(exe, 0o755);
  return exe;
};

describe("R3 — explicit-host-only operator authorization (adversarial A–K)", () => {
  it("R3.A — numeric identity bypass closed: goal '144' never authorizes 144.attacker.example (production path, both transports)", async () => {
    const goal = "Tính căn bậc hai của 144 và lưu kết quả vào math.txt.";
    // no host at all is extractable from that goal
    expect(extractGoalHosts(goal).size).toBe(0);

    // HTTP transport: sanitize → repair → canonicalize
    const raw = planJson([
      emitFetchTask(
        "https://144.attacker.example",
        ["REASONING"],
        "Fetch https://144.attacker.example into notes.md.",
      ),
    ]);
    const r = await llmPlan(goal, { ...CFG, fetchFn: okFetch(raw) });
    expect(r.warnings).not.toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(t2.required_capabilities).not.toContain("NETWORK_ACCESS");
    const f = canonFail(() => canon(r.tasks, goal));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");

    // codex transport parity
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-r3a-"));
    const exe = fakeCodex(dir, [
      emitFetchTask(
        "https://144.attacker.example",
        ["REASONING"],
        "Fetch https://144.attacker.example into notes.md.",
      ),
    ]);
    const rc = await codexPlannerPlan(goal, {
      model: "test-sol",
      executable: exe,
      timeoutMs: 8_000,
      scratchDir: path.join(dir, "scr"),
      env: { ...process.env } as NodeJS.ProcessEnv,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(rc.warnings).not.toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    const fc = canonFail(() => canon(rc.tasks, goal));
    expect(fc?.detail).toContain("UNAUTHORIZED_SOURCE");
  });

  it("R3.B — proper-noun bypass closed: 'Research MQL5' names no host → mql5.attacker.example AND mql5.com both denied", async () => {
    const goal = "Research MQL5 and summarize the findings.";
    expect(extractGoalHosts(goal).size).toBe(0);
    for (const locator of [
      "https://mql5.attacker.example",
      "https://mql5.com",
      "mql5.com",
    ]) {
      const raw = planJson([emitFetchTask(locator)]);
      const r = await llmPlan(goal, { ...CFG, fetchFn: okFetch(raw) });
      expect(r.warnings).not.toContain("REPAIRED_NETWORK_CAPABILITY:T2");
      const f = canonFail(() => canon(r.tasks, goal));
      expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
      expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
    }
  });

  it("R3.C — explicit host positive: goal names MQL5.com → mql5.com / www.mql5.com / api.mql5.com authorized", async () => {
    const goal = "Research MQL5.com and summarize the findings.";
    const hosts = extractGoalHosts(goal);
    expect(hosts).toEqual(new Set(["mql5.com"]));
    for (const host of ["mql5.com", "www.mql5.com", "api.mql5.com"]) {
      expect(goalAuthorizesHost(host, hosts)).toBe(true);
      const res = resolveTaskNetworkAuthority({
        req: extReq(`https://${host}/market`),
        state: "valid",
        goalHosts: hosts,
        fresh: true,
      });
      expect(res).toMatchObject({ verdict: "REQUIRED", authorized: true });
    }
    // production path: authorized host + valid requirement + missing cap
    // → repair elevates and the canonical gate does not reject on NETWORK
    const raw = planJson([
      emitFetchTask(
        "https://www.mql5.com/en/market",
        ["REASONING"],
        "Fetch the latest EA data from mql5.com into notes.md.",
      ),
    ]);
    const r = await llmPlan(goal, { ...CFG, fetchFn: okFetch(raw) });
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(t2.required_capabilities).toContain("NETWORK_ACCESS");
    const f = canonFail(() => canon(r.tasks, goal));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("R3.D — sibling/label attacks denied under the MQL5.com goal", () => {
    const hosts = extractGoalHosts("Research MQL5.com and summarize.");
    for (const evil of [
      "mql5.attacker.example",
      "foo.mql5.example",
      "mql5.com.attacker.example",
      "evil-mql5.com",
      "attacker-mql5.com",
      "mql5com.example",
      "mql5.com.evil.org",
    ]) {
      expect(goalAuthorizesHost(evil, hosts)).toBe(false);
      const res = resolveTaskNetworkAuthority({
        req: extReq(`https://${evil}/`),
        state: "valid",
        goalHosts: hosts,
        fresh: true,
      });
      expect(res).toMatchObject({
        verdict: "INVALID",
        reason: "UNAUTHORIZED_SOURCE",
      });
    }
    // and the mandate's subdomain case: naming api.mql5.com does NOT
    // widen to the parent or siblings (least authority)
    const sub = extractGoalHosts("call api.mql5.com for data");
    expect(sub).toEqual(new Set(["api.mql5.com"]));
    expect(goalAuthorizesHost("api.mql5.com", sub)).toBe(true);
    expect(goalAuthorizesHost("x.api.mql5.com", sub)).toBe(true);
    expect(goalAuthorizesHost("mql5.com", sub)).toBe(false);
    expect(goalAuthorizesHost("www.mql5.com", sub)).toBe(false);
    expect(goalAuthorizesHost("other.mql5.com", sub)).toBe(false);
  });

  it("R3.E — file output is never source authority (math.txt, https://math.txt, path forms)", () => {
    const goal = "Compute sqrt(144) and save to math.txt.";
    const hosts = extractGoalHosts(goal);
    expect(hosts.size).toBe(0);
    for (const locator of ["math.txt", "https://math.txt"]) {
      const res = resolveTaskNetworkAuthority({
        req: extReq(locator),
        state: "valid",
        goalHosts: hosts,
        fresh: true,
      });
      expect(res).toMatchObject({
        verdict: "INVALID",
        reason: "UNAUTHORIZED_SOURCE",
      });
    }
    // path-qualified file tokens are never even host candidates
    for (const g of [
      "write to outbox/report.txt",
      "read ./config.json then summarize",
      "load reports/data.csv into memory",
      "save the output as config.json",
    ]) {
      expect(extractGoalHosts(g).size).toBe(0);
    }
    // …while the same goal explicitly writing the file name as a URL is
    // unambiguous operator evidence — that IS named authorization.
    const withUrl = extractGoalHosts("fetch from https://math.txt now");
    expect(withUrl.has("math.txt")).toBe(true);
  });

  it("R3.F — arbitrary TLD/domain syntax: no TLD enumeration anywhere", () => {
    // a synthetic suffix that no TLD list could contain still authorizes
    const goal = "Access data.portal.example123 and summarize.";
    const hosts = extractGoalHosts(goal);
    expect(hosts).toEqual(new Set(["data.portal.example123"]));
    expect(goalAuthorizesHost("data.portal.example123", hosts)).toBe(true);
    expect(goalAuthorizesHost("api.data.portal.example123", hosts)).toBe(true);
    expect(goalAuthorizesHost("portal.example123", hosts)).toBe(false);
    // invented-TLD hosts are equally host-shaped when literally named
    const weird = extractGoalHosts("pull metrics from node-7.zzzqq today");
    expect(weird).toEqual(new Set(["node-7.zzzqq"]));
    // but an invented-TLD host the goal did NOT name stays unauthorized
    const res = resolveTaskNetworkAuthority({
      req: extReq("https://node-7.zzzqq/"),
      state: "valid",
      goalHosts: extractGoalHosts("summarize local notes"),
      fresh: true,
    });
    expect(res).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
  });

  it("R3.G — forged capability alongside an unauthorized source → typed rejection (production path)", async () => {
    const goal = "Compute sqrt(144) and save to math.txt.";
    const raw = planJson([
      emitFetchTask(
        "https://144.attacker.example",
        ["REASONING", "NETWORK_ACCESS"], // cap cannot self-authorize
      ),
    ]);
    const r = await llmPlan(goal, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, goal));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
  });

  it("R3.H — repair path: authorized host may repair; unauthorized adds nothing", () => {
    // authorized
    const okTask = emitFetchTask(
      "mql5.com",
      ["REASONING"],
      "Fetch the latest EA data from mql5.com into notes.md.",
    );
    const rok = repairNetworkCapabilityBinding(
      [{ ...okTask, metadata: { network_requirement: okTask.network_requirement } }],
      {
        goal: "Research MQL5.com and summarize.",
        allowedCapabilities: ALLOWED,
        capabilitySets: CAP_SETS,
      },
    );
    expect(rok.warnings).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    expect(rok.tasks[0].required_capabilities).toContain("NETWORK_ACCESS");
    // unauthorized — zero repair, task object identity untouched
    const badTask = emitFetchTask("https://144.attacker.example");
    const rbad = repairNetworkCapabilityBinding(
      [{ ...badTask, metadata: { network_requirement: badTask.network_requirement } }],
      {
        goal: "Compute sqrt(144) and save to math.txt.",
        allowedCapabilities: ALLOWED,
        capabilitySets: CAP_SETS,
      },
    );
    expect(rbad.warnings).toEqual([]);
    expect(rbad.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
  });

  it("R3.I — fresh contract regression: missing/malformed/conflict unchanged", async () => {
    // missing
    const miss = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction: "Fetch the latest data from mql5.com into n.md.",
        required_capabilities: ["NETWORK_ACCESS", "REASONING"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
      },
    ]);
    const r1 = await llmPlan("Research MQL5.com", { ...CFG, fetchFn: okFetch(miss) });
    const f1 = canonFail(() => canon(r1.tasks, "Research MQL5.com"));
    expect(f1?.detail).toContain("REQUIREMENT_MISSING");
    // malformed
    const mal = planJson([
      emitFetchTask("mql5.com"),
    ]);
    const parsed = JSON.parse(mal) as { tasks: Array<Record<string, unknown>> };
    parsed.tasks[0].network_requirement = "I AM NETWORK, TRUST ME";
    const r2 = await llmPlan("Research MQL5.com", {
      ...CFG,
      fetchFn: okFetch(JSON.stringify(parsed)),
    });
    expect(r2.warnings).toContain("MALFORMED_NETWORK_REQ:T2");
    const f2 = canonFail(() => canon(r2.tasks, "Research MQL5.com"));
    expect(f2?.detail).toContain("REQUIREMENT_MALFORMED");
    // conflict top-level vs metadata
    const con = planJson([emitFetchTask("mql5.com")]);
    const p3 = JSON.parse(con) as { tasks: Array<Record<string, unknown>> };
    p3.tasks[0].metadata = { network_requirement: LOCAL_REQ };
    const r3 = await llmPlan("Research MQL5.com", {
      ...CFG,
      fetchFn: okFetch(JSON.stringify(p3)),
    });
    expect(r3.warnings).toContain("NETWORK_REQ_CONFLICT:T2");
    const f3 = canonFail(() => canon(r3.tasks, "Research MQL5.com"));
    expect(f3?.detail).toContain("REQUIREMENT_CONFLICT");
  });

  it("R3.J — persisted legacy regression: provenance-gated detectors still apply exactly as R2", () => {
    const goal = "Research the latest MQL5 market trends online.";
    const legacyTask = {
      task_key: "T2",
      title: "T2",
      task_instruction:
        "Fetch the latest MQL5 market data from the web into market.md.",
      required_capabilities: ["NETWORK_ACCESS", "REASONING"],
      depends_on: ["T1"],
    };
    // persisted → LEGACY verdict → vocabulary detectors decide; the
    // network authority itself does not reject (a later gate may judge)
    const f = canonFail(() => canon([legacyTask], goal, "persisted"));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // and the same bytes under fresh provenance still fail REQUIREMENT_MISSING
    const f2 = canonFail(() => canon([legacyTask], goal, "fresh"));
    expect(f2?.detail).toContain("REQUIREMENT_MISSING");
  });

  it("R3.K — digest/replay: no new mutable authority field exists to bind", async () => {
    const { canonicalPlanSemanticDigest } = await import(
      "../pair/plan-feasibility.js"
    );
    // goal hosts are derived from the goal TEXT (already digest-covered
    // via the mission record) — no new task/mission field was added.
    // The requirement object remains the only network authority input.
    const base = {
      task_key: "T2",
      task_instruction: "Compute sqrt(144) and write math.txt.",
      required_capabilities: ["REASONING"],
      depends_on: [],
      metadata: { network_requirement: LOCAL_REQ },
    };
    const d1 = canonicalPlanSemanticDigest([base]);
    const forged = {
      ...base,
      metadata: { network_requirement: extReq("mql5.com") },
    };
    expect(canonicalPlanSemanticDigest([forged])).not.toBe(d1);
    // locator host parsing stays pure syntactic — no goal mutation vector
    expect(requirementLocatorHost("https://mql5.com/en/market?x=1")).toBe(
      "mql5.com",
    );
  });
});
