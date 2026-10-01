/**
 * Phase A — foundation + security hardening tests.
 *
 * A: validated env-config timeouts (fail-closed parsing, bounds, defaults).
 * B: canonical model roles (PLANNER_COORDINATOR / DSH_EXECUTION) — assigned
 *    via model_role_assignment entities keyed by model_entry_id.
 * C: strict Planner∩DSH = ∅ separation on canonical model identity.
 * D: MC token resolution — env > persisted file > generated, never defaults.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IntegrityError,
  ModelEvidenceCatalog,
  PairControlPlane,
  PairEvidenceStore,
  assignModelRole,
  assertCanonicalModelRoleStateDisjoint,
  assertDshExecutionModelRole,
  assertModelRole,
  assertNoModelRoleOverlap,
  assertPlannerModelRole,
  canonicalModelId,
  listModelRoleAssignments,
  llmPlannerTimeoutMs,
  modelProbeTimeoutMs,
  modelRoleAssignmentId,
  modelRoleOf,
  readPositiveIntEnv,
  reconcileModelRoleAssignments,
  resolveMcToken,
  revokeModelRole,
  sameCanonicalModel,
  taskTimeoutSeconds,
  KNOWN_STATIC_TOKENS,
  MODEL_ROLE,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phase-a-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

function makeCtx(n: string) {
  const dir = freshDir(n);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const mcat = new ModelEvidenceCatalog(store);
  return { dir, store, service, mcat };
}

function addModel(ctx: ReturnType<typeof makeCtx>, providerFamily: string, modelId: string, alias?: string) {
  const { entry } = ctx.mcat.upsertModelClaim({
    provider_id: providerFamily,
    provider_family: providerFamily,
    model_id: modelId,
    model_native_id: alias,
    capability_hints: ["text_inference"],
  });
  return entry;
}

const expectFailClosed = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrityError);
    expect(String((e as IntegrityError).message)).toContain(code);
    return;
  }
  throw new Error(`expected ${code} failure`);
};

/* ============================== A. timeouts ============================== */

describe("A — canonical timeout config", () => {
  const env = (k: string, v: string) => ({ [k]: v });

  it("reads valid values for all three knobs", () => {
    expect(modelProbeTimeoutMs(env("PAIR_MODEL_PROBE_TIMEOUT_MS", "45000"))).toBe(45000);
    expect(llmPlannerTimeoutMs(env("PAIR_LLM_PLANNER_TIMEOUT_MS", "120000"))).toBe(120000);
    expect(taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "600"))).toBe(600);
  });

  it("safe defaults when unset", () => {
    expect(modelProbeTimeoutMs({})).toBe(8_000);
    expect(llmPlannerTimeoutMs({})).toBe(20_000);
    expect(taskTimeoutSeconds({})).toBe(120);
  });

  it("zero fails closed", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "0")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => modelProbeTimeoutMs(env("PAIR_MODEL_PROBE_TIMEOUT_MS", "0")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("negative fails closed", () => {
    expectFailClosed(() => llmPlannerTimeoutMs(env("PAIR_LLM_PLANNER_TIMEOUT_MS", "-5")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("non-numeric fails closed", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "abc")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "12x")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("Infinity / unsafe magnitudes cannot disable governance", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "Infinity")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "999999999999")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => modelProbeTimeoutMs(env("PAIR_MODEL_PROBE_TIMEOUT_MS", "1e9")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("non-integer fails closed (units are integers)", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "8.5")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("above the documented bound fails closed", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "7201")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => modelProbeTimeoutMs(env("PAIR_MODEL_PROBE_TIMEOUT_MS", "120001")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("below the documented bound fails closed", () => {
    expectFailClosed(() => taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "4")), "FAIL_CLOSED_CONFIG_INVALID");
    expectFailClosed(() => llmPlannerTimeoutMs(env("PAIR_LLM_PLANNER_TIMEOUT_MS", "1999")), "FAIL_CLOSED_CONFIG_INVALID");
  });

  it("empty env falls back to default (not an error)", () => {
    expect(taskTimeoutSeconds(env("PAIR_TASK_TIMEOUT_S", "  "))).toBe(120);
  });

  it("generic reader enforces bounds on the default itself", () => {
    expectFailClosed(
      () => readPositiveIntEnv("UNSET_X", 999, { min: 1, max: 10, unit: "ms" }, {}),
      "FAIL_CLOSED_CONFIG_INVALID",
    );
  });
});

/* ============================== B. model roles ============================ */

describe("B — canonical model roles", () => {
  it("planner-pool model is valid for planner, invalid for dsh", () => {
    const ctx = makeCtx("planner-only");
    const m = addModel(ctx, "gemini", "gemini-x");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    expect(() => assertPlannerModelRole(ctx.store, String(m.model_entry_id))).not.toThrow();
    expectFailClosed(
      () => assertDshExecutionModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_MISMATCH",
    );
  });

  it("dsh-pool model is valid for dsh, invalid for planner", () => {
    const ctx = makeCtx("dsh-only");
    const m = addModel(ctx, "cloudflare", "@cf/x");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    expect(() => assertDshExecutionModelRole(ctx.store, String(m.model_entry_id))).not.toThrow();
    expectFailClosed(
      () => assertPlannerModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_MISMATCH",
    );
  });

  it("unassigned model is eligible for neither role (default-deny)", () => {
    const ctx = makeCtx("unassigned");
    const m = addModel(ctx, "groq", "m1");
    expect(modelRoleOf(ctx.store, String(m.model_entry_id))).toBeNull();
    expectFailClosed(
      () => assertPlannerModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_UNASSIGNED",
    );
    expectFailClosed(
      () => assertDshExecutionModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_UNASSIGNED",
    );
  });

  it("role is denied when the model is REMOVED/BLOCKED", () => {
    const ctx = makeCtx("unusable");
    const m = addModel(ctx, "groq", "m1");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    const body = { ...m, conditions: ["REMOVED"], version: Number(m.version) };
    ctx.store.put("model_entry", String(m.model_entry_id), body, Number(m.version));
    expectFailClosed(
      () => assertDshExecutionModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE",
    );
  });

  it("invalid role strings are rejected", () => {
    const ctx = makeCtx("bad-role");
    const m = addModel(ctx, "groq", "m1");
    expectFailClosed(
      () => assignModelRole(ctx.store, String(m.model_entry_id), "ROOT"),
      "FAIL_CLOSED_MODEL_ROLE_INVALID",
    );
  });

  it("assignment on an unknown model fails closed", () => {
    const ctx = makeCtx("unknown-model");
    try {
      assignModelRole(ctx.store, "ME_DOESNOTEXIST", MODEL_ROLE.DSH_EXECUTION);
      throw new Error("expected failure");
    } catch (e) {
      expect(String(e)).toContain("model_entry:ME_DOESNOTEXIST");
    }
  });

  it("roles persist across restart (reopened store)", () => {
    const ctx = makeCtx("persist");
    const m = addModel(ctx, "gemini", "gemini-x");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    // reopen a fresh store on the same db file — restart reconstruction
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    expect(modelRoleOf(store2, String(m.model_entry_id))).toBe(MODEL_ROLE.PLANNER_COORDINATOR);
    expect(() => assertPlannerModelRole(store2, String(m.model_entry_id))).not.toThrow();
  });

  it("reassignment is explicit and audited", () => {
    const ctx = makeCtx("reassign");
    const m = addModel(ctx, "gemini", "gemini-x");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    expect(modelRoleOf(ctx.store, String(m.model_entry_id))).toBe(MODEL_ROLE.DSH_EXECUTION);
    const events = ctx.store.listEvents("model_role_assignment", modelRoleAssignmentId(String(m.model_entry_id)));
    expect(events.map((e) => e.event_type)).toEqual(["MODEL_ROLE_ASSIGNED", "MODEL_ROLE_REASSIGNED"]);
  });

  it("revocation removes eligibility and is audited", () => {
    const ctx = makeCtx("revoke");
    const m = addModel(ctx, "gemini", "gemini-x");
    assignModelRole(ctx.store, String(m.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    revokeModelRole(ctx.store, String(m.model_entry_id));
    expect(modelRoleOf(ctx.store, String(m.model_entry_id))).toBeNull();
    expectFailClosed(
      () => assertPlannerModelRole(ctx.store, String(m.model_entry_id)),
      "FAIL_CLOSED_MODEL_ROLE_UNASSIGNED",
    );
    const events = ctx.store.listEvents("model_role_assignment", modelRoleAssignmentId(String(m.model_entry_id)));
    expect(events.at(-1)?.event_type).toBe("MODEL_ROLE_REVOKED");
  });

  it("assignments are queryable per pool", () => {
    const ctx = makeCtx("list");
    const a = addModel(ctx, "gemini", "g1");
    const b = addModel(ctx, "groq", "m1");
    const c = addModel(ctx, "cloudflare", "@cf/x");
    assignModelRole(ctx.store, String(a.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    assignModelRole(ctx.store, String(b.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    assignModelRole(ctx.store, String(c.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    const rows = listModelRoleAssignments(ctx.store);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.role === MODEL_ROLE.DSH_EXECUTION)).toHaveLength(2);
  });
});

/* ============================== C. strict separation ===================== */

describe("C — Planner ∩ DSH = ∅ on canonical identity", () => {
  const pools = (ctx: ReturnType<typeof makeCtx>, planner: [string, string][], dsh: [string, string][]) => ({
    planner: planner.map(([p, m]) => ({ model_entry_id: String(ctx.mcat.getModelByIds(p, m)!.model_entry_id), ref: `${p}:${m}` })),
    dsh: dsh.map(([p, m]) => ({ model_entry_id: String(ctx.mcat.getModelByIds(p, m)!.model_entry_id), ref: `${p}:${m}` })),
  });

  it("same provider, different models → disjoint pools pass", () => {
    const ctx = makeCtx("same-prov-diff-models");
    addModel(ctx, "gemini", "g-a");
    addModel(ctx, "gemini", "g-b");
    const p = pools(ctx, [["gemini", "g-a"]], [["gemini", "g-b"], ["gemini", "g-b"]]);
    expect(() => assertNoModelRoleOverlap(ctx.store, p)).not.toThrow();
  });

  it("same model in both pools → FAIL_CLOSED_MODEL_ROLE_OVERLAP", () => {
    const ctx = makeCtx("overlap-same");
    addModel(ctx, "gemini", "g-a");
    addModel(ctx, "groq", "m1");
    const p = pools(ctx, [["gemini", "g-a"]], [["gemini", "g-a"], ["groq", "m1"]]);
    expectFailClosed(() => assertNoModelRoleOverlap(ctx.store, p), "FAIL_CLOSED_MODEL_ROLE_OVERLAP");
  });

  it("same model via different route spellings → overlap fails on canonical id", () => {
    const ctx = makeCtx("overlap-spelling");
    addModel(ctx, "GEMINI", "g-a");
    // model_entry_id is case-insensitive on provider_family
    expect(canonicalModelId("gemini", "g-a")).toBe(canonicalModelId("GEMINI", "g-a"));
    const me = ctx.mcat.getModelByIds("gemini", "g-a")!;
    expectFailClosed(
      () =>
        assertNoModelRoleOverlap(ctx.store, {
          planner: [{ model_entry_id: String(me.model_entry_id), ref: "gemini:g-a" }],
          dsh: [{ model_entry_id: String(me.model_entry_id), ref: "GEMINI:g-a" }],
        }),
      "FAIL_CLOSED_MODEL_ROLE_OVERLAP",
    );
  });

  it("overlap diagnostics carry safe refs only (no secrets)", () => {
    const ctx = makeCtx("overlap-safe-diag");
    addModel(ctx, "gemini", "g-a");
    const me = ctx.mcat.getModelByIds("gemini", "g-a")!;
    try {
      assertNoModelRoleOverlap(ctx.store, {
        planner: [{ model_entry_id: String(me.model_entry_id), ref: "gemini:g-a" }],
        dsh: [{ model_entry_id: String(me.model_entry_id), ref: "gemini:g-a#dsh" }],
      });
      throw new Error("expected failure");
    } catch (e) {
      const msg = String((e as IntegrityError).message);
      expect(msg).toContain("g-a");
      expect(msg).not.toContain("API_KEY");
      expect(msg).not.toContain("TOKEN");
    }
  });
});

/* ============================== identity ================================== */

describe("C — canonical identity", () => {
  it("normalization is stable (provider case + whitespace)", () => {
    expect(canonicalModelId("Gemini", "m1")).toBe(canonicalModelId("GEMINI", "m1"));
    expect(canonicalModelId(" gemini ", " m1 ")).toBe(canonicalModelId("gemini", "m1"));
  });

  it("equivalent route spellings resolve to the same entry", () => {
    const ctx = makeCtx("equiv-routes");
    const m = addModel(ctx, "Gemini", "g-a");
    const a = ctx.mcat.getModelByIds("GEMINI", "g-a");
    const b = ctx.mcat.getModelByIds(" gemini ", " g-a ");
    expect(String(a!.model_entry_id)).toBe(String(m.model_entry_id));
    expect(String(b!.model_entry_id)).toBe(String(m.model_entry_id));
  });

  it("proven aliases collapse to the same canonical model", () => {
    const ctx = makeCtx("alias-proven");
    const m = addModel(ctx, "gemini", "g-a", "g-a-native"); // native id recorded as alias
    // A second entry whose model_id is the first entry's proven alias —
    // e.g. discovery later reported the alias as its own model row.
    const other = addModel(ctx, "gemini", "g-a-native");
    expect(String(other.model_entry_id)).not.toBe(String(m.model_entry_id));
    expect(sameCanonicalModel(m, other)).toBe(true);
    // …and pool overlap catches it via alias equivalence.
    expectFailClosed(
      () =>
        assertNoModelRoleOverlap(ctx.store, {
          planner: [{ model_entry_id: String(m.model_entry_id), ref: "gemini:g-a" }],
          dsh: [{ model_entry_id: String(other.model_entry_id), ref: "gemini:g-a-native" }],
        }),
      "FAIL_CLOSED_MODEL_ROLE_OVERLAP",
    );
  });

  it("unproven same-family models are NOT collapsed (conservative)", () => {
    const ctx = makeCtx("alias-unknown");
    const a = addModel(ctx, "gemini", "g-a");
    const b = addModel(ctx, "gemini", "g-b");
    expect(sameCanonicalModel(a, b)).toBe(false);
  });

  it("different provider families never collapse", () => {
    const ctx = makeCtx("diff-family");
    const a = addModel(ctx, "gemini", "m1");
    const b = addModel(ctx, "groq", "m1");
    expect(sameCanonicalModel(a, b)).toBe(false);
    // different canonical entries → pools are disjoint
    expect(String(a.model_entry_id)).not.toBe(String(b.model_entry_id));
  });
});

/* ============================== D. MC token ============================== */

describe("D — MC token hardening", () => {
  it("explicit PAIR_MC_TOKEN wins", () => {
    const dir = freshDir("tok-env");
    const r = resolveMcToken({ env: { PAIR_MC_TOKEN: "op-token" }, homeDir: dir });
    expect(r).toMatchObject({ token: "op-token", source: "env" });
  });

  it("persisted file is reused when env absent", () => {
    const dir = freshDir("tok-file");
    fs.writeFileSync(path.join(dir, "pair-mc-token"), "file-token", { mode: 0o600 });
    const r = resolveMcToken({ env: {}, homeDir: dir });
    expect(r).toMatchObject({ token: "file-token", source: "file" });
  });

  it("absent env+file → generates a >=256-bit token and persists chmod 600", () => {
    const dir = freshDir("tok-gen");
    const r = resolveMcToken({ env: {}, homeDir: dir });
    expect(r.source).toBe("generated");
    expect(r.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 256 bits
    const st = fs.statSync(r.path);
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(r.path, "utf8")).toBe(r.token);
  });

  it("generated token is never a known static default", () => {
    const dir = freshDir("tok-nostatic");
    const r = resolveMcToken({ env: {}, homeDir: dir });
    expect(KNOWN_STATIC_TOKENS.has(r.token)).toBe(false);
    expect(r.token.length).toBeGreaterThanOrEqual(32);
  });

  it("restart stability: second resolve reuses the persisted token", () => {
    const dir = freshDir("tok-restart");
    const r1 = resolveMcToken({ env: {}, homeDir: dir });
    const r2 = resolveMcToken({ env: {}, homeDir: dir });
    expect(r2).toMatchObject({ token: r1.token, source: "file" });
  });

  it("server and bridge resolve the same token", () => {
    const dir = freshDir("tok-shared");
    const server = resolveMcToken({ env: {}, homeDir: dir });
    const bridge = resolveMcToken({ env: {}, homeDir: dir });
    expect(bridge.token).toBe(server.token);
  });

  it("empty / whitespace env fails closed", () => {
    const dir = freshDir("tok-empty");
    expectFailClosed(() => resolveMcToken({ env: { PAIR_MC_TOKEN: "" }, homeDir: dir }), "FAIL_CLOSED_MC_TOKEN_INVALID");
    expectFailClosed(() => resolveMcToken({ env: { PAIR_MC_TOKEN: "   " }, homeDir: dir }), "FAIL_CLOSED_MC_TOKEN_INVALID");
  });

  it("whitespace-padded env fails closed", () => {
    const dir = freshDir("tok-pad");
    expectFailClosed(() => resolveMcToken({ env: { PAIR_MC_TOKEN: " abc " }, homeDir: dir }), "FAIL_CLOSED_MC_TOKEN_INVALID");
  });

  it("a persisted known-static token fails closed (never auto-trusted)", () => {
    const dir = freshDir("tok-weakfile");
    fs.writeFileSync(path.join(dir, "pair-mc-token"), "123");
    expectFailClosed(() => resolveMcToken({ env: {}, homeDir: dir }), "FAIL_CLOSED_MC_TOKEN_WEAK");
  });

  it("token never enters canonical entities/events/evidence", () => {
    const ctx = makeCtx("tok-clean");
    const r = resolveMcToken({ env: {}, homeDir: ctx.dir });
    // emit representative canonical writes the server performs at boot
    ctx.service.registerCapability("TEXT_INFERENCE", { risk_class: "LOW" });
    addModel(ctx, "gemini", "g-a");
    const hay = JSON.stringify({
      entities: ["mission", "model_entry", "model_role_assignment", "capability"].flatMap((t) => ctx.store.list(t)),
      events: ctx.store.listEvents(),
      evidence: ctx.store.listEvidence(),
    });
    expect(hay).not.toContain(r.token);
  });

  it("existing permissive file is tightened to 0600 before use (R1)", () => {
    const dir = freshDir("tok-perms");
    const fp = path.join(dir, "pair-mc-token");
    fs.writeFileSync(fp, "good-token-value", { mode: 0o644 });
    const r = resolveMcToken({ env: {}, homeDir: dir });
    expect(r.token).toBe("good-token-value");
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });

  it("existing file already 0600 stays unchanged", () => {
    const dir = freshDir("tok-perms-ok");
    const fp = path.join(dir, "pair-mc-token");
    fs.writeFileSync(fp, "ok-token", { mode: 0o600 });
    const r = resolveMcToken({ env: {}, homeDir: dir });
    expect(r.token).toBe("ok-token");
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });
});

/* ================= R1 — canonical role reconciliation ==================== */

describe("R1 — reconcileModelRoleAssignments", () => {
  const refs = (ctx: ReturnType<typeof makeCtx>, planner: [string, string][], dsh: [string, string][]) => ({
    planner: planner.map(([p, m]) => ({ model_entry_id: String(ctx.mcat.getModelByIds(p, m)!.model_entry_id), ref: `${p}:${m}` })),
    dsh: dsh.map(([p, m]) => ({ model_entry_id: String(ctx.mcat.getModelByIds(p, m)!.model_entry_id), ref: `${p}:${m}` })),
  });
  const activeRoles = (ctx: ReturnType<typeof makeCtx>) =>
    listModelRoleAssignments(ctx.store)
      .filter((r) => r.role !== null)
      .map((r) => `${String(r.model_id)}=${String(r.role)}`)
      .sort();
  const roleEvents = (ctx: ReturnType<typeof makeCtx>) =>
    ctx.store.listEvents("model_role_assignment").map((e) => e.event_type);

  it("A — remove old planner: stale planner revoked on reconfigure", () => {
    const ctx = makeCtx("r1-a");
    const A = addModel(ctx, "gemini", "a");
    const B = addModel(ctx, "groq", "b");
    const C = addModel(ctx, "cloudflare", "c");
    reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], [["groq", "b"]]));
    const res = reconcileModelRoleAssignments(ctx.store, refs(ctx, [["cloudflare", "c"]], [["groq", "b"]]));
    expect(res.revoked).toEqual([String(A.model_entry_id)]);
    expect(res.created).toEqual([String(C.model_entry_id)]);
    expect(res.noop).toEqual([String(B.model_entry_id)]);
    expect(activeRoles(ctx)).toEqual([`b=${MODEL_ROLE.DSH_EXECUTION}`, `c=${MODEL_ROLE.PLANNER_COORDINATOR}`]);
    // stale row is inactive (role=null) not deleted — history preserved
    const stale = ctx.store.tryGet("model_role_assignment", modelRoleAssignmentId(String(A.model_entry_id)))!;
    expect(stale.role).toBeNull();
    expect(stale.revoked_from).toBe(MODEL_ROLE.PLANNER_COORDINATOR);
  });

  it("B — remove old DSH: extra DSH assignment revoked", () => {
    const ctx = makeCtx("r1-b");
    addModel(ctx, "gemini", "a");
    const B = addModel(ctx, "groq", "b");
    addModel(ctx, "cloudflare", "c");
    reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], [["groq", "b"], ["cloudflare", "c"]]));
    const res = reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], [["cloudflare", "c"]]));
    expect(res.revoked).toEqual([String(B.model_entry_id)]);
    expect(activeRoles(ctx)).toEqual([`a=${MODEL_ROLE.PLANNER_COORDINATOR}`, `c=${MODEL_ROLE.DSH_EXECUTION}`]);
  });

  it("C — swap role: B audited REASSIGNED DSH→PLANNER, A revoked, C created", () => {
    const ctx = makeCtx("r1-c");
    const A = addModel(ctx, "gemini", "a");
    const B = addModel(ctx, "groq", "b");
    addModel(ctx, "cloudflare", "c");
    reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], [["groq", "b"]]));
    const before = roleEvents(ctx).length;
    const res = reconcileModelRoleAssignments(ctx.store, refs(ctx, [["groq", "b"]], [["cloudflare", "c"]]));
    expect(res.reassigned).toEqual([String(B.model_entry_id)]);
    expect(res.revoked).toEqual([String(A.model_entry_id)]);
    expect(res.created).toEqual([String(res.created[0])]);
    expect(activeRoles(ctx)).toEqual([`b=${MODEL_ROLE.PLANNER_COORDINATOR}`, `c=${MODEL_ROLE.DSH_EXECUTION}`]);
    const newEvents = roleEvents(ctx).slice(before);
    expect(newEvents).toContain("MODEL_ROLE_REASSIGNED");
    expect(newEvents).toContain("MODEL_ROLE_REVOKED");
    expect(newEvents).toContain("MODEL_ROLE_ASSIGNED");
  });

  it("D — proven-alias stale overlap: revoked stale planner before final assertion", () => {
    const ctx = makeCtx("r1-d");
    const A = addModel(ctx, "gemini", "a", "a-alias"); // A aliases "a-alias"
    const B = addModel(ctx, "gemini", "a-alias");      // separate entry, proven alias of A
    addModel(ctx, "groq", "c");
    // state 1: A is planner
    reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], []));
    // state 2: C planner, B dsh — A's alias B now sits in the DSH pool
    const res = reconcileModelRoleAssignments(ctx.store, refs(ctx, [["groq", "c"]], [["gemini", "a-alias"]]));
    expect(res.revoked).toEqual([String(A.model_entry_id)]);
    // final stored state must be disjoint — A inactive so B's dsh role is legal
    expect(() => assertCanonicalModelRoleStateDisjoint(ctx.store)).not.toThrow();
    expect(activeRoles(ctx)).toEqual([`a-alias=${MODEL_ROLE.DSH_EXECUTION}`, `c=${MODEL_ROLE.PLANNER_COORDINATOR}`]);
  });

  it("E — idempotent restart: same config twice produces no new events", () => {
    const ctx = makeCtx("r1-e");
    addModel(ctx, "gemini", "a");
    addModel(ctx, "groq", "b");
    const r = refs(ctx, [["gemini", "a"]], [["groq", "b"]]);
    reconcileModelRoleAssignments(ctx.store, r);
    const eventsAfterFirst = roleEvents(ctx).length;
    const res2 = reconcileModelRoleAssignments(ctx.store, r);
    expect(res2.noop).toHaveLength(2);
    expect(res2.created).toHaveLength(0);
    expect(res2.reassigned).toHaveLength(0);
    expect(res2.revoked).toHaveLength(0);
    expect(roleEvents(ctx).length).toBe(eventsAfterFirst); // zero new events
  });

  it("F — unknown configured ref fails closed (no partial topology)", () => {
    const ctx = makeCtx("r1-f");
    addModel(ctx, "gemini", "a");
    try {
      reconcileModelRoleAssignments(ctx.store, {
        planner: [{ model_entry_id: "ME_GHOST", ref: "x:y" }],
        dsh: [],
      });
      throw new Error("expected failure");
    } catch (e) {
      expect(String(e)).toContain("model_entry:ME_GHOST");
    }
    expect(listModelRoleAssignments(ctx.store)).toHaveLength(0); // nothing applied
  });

  it("atomicity — desired-pool overlap rolls back ALL mutations", () => {
    const ctx = makeCtx("r1-atomic");
    const A = addModel(ctx, "gemini", "a");
    addModel(ctx, "groq", "b");
    reconcileModelRoleAssignments(ctx.store, refs(ctx, [["gemini", "a"]], [["groq", "b"]]));
    // desired overlap: same model in both pools → whole txn must roll back
    expectFailClosed(
      () =>
        reconcileModelRoleAssignments(ctx.store, {
          planner: [{ model_entry_id: String(A.model_entry_id) }],
          dsh: [{ model_entry_id: String(A.model_entry_id) }],
        }),
      "FAIL_CLOSED_MODEL_ROLE_OVERLAP",
    );
    // previous topology untouched: A still planner, b still dsh
    expect(activeRoles(ctx)).toEqual([`a=${MODEL_ROLE.PLANNER_COORDINATOR}`, `b=${MODEL_ROLE.DSH_EXECUTION}`]);
  });
});

describe("R1 — assertCanonicalModelRoleStateDisjoint (final stored state)", () => {
  it("passes on a disjoint active set", () => {
    const ctx = makeCtx("fd-ok");
    const A = addModel(ctx, "gemini", "a");
    const B = addModel(ctx, "groq", "b");
    assignModelRole(ctx.store, String(A.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    assignModelRole(ctx.store, String(B.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    expect(() => assertCanonicalModelRoleStateDisjoint(ctx.store)).not.toThrow();
  });

  it("fails when active stored roles overlap (stale-config class)", () => {
    const ctx = makeCtx("fd-bad");
    // simulate the audit's dangerous state: A planner + alias-B dsh coexist
    const A = addModel(ctx, "gemini", "a", "a-alias");
    const B = addModel(ctx, "gemini", "a-alias");
    assignModelRole(ctx.store, String(A.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    assignModelRole(ctx.store, String(B.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    expectFailClosed(
      () => assertCanonicalModelRoleStateDisjoint(ctx.store),
      "FAIL_CLOSED_MODEL_ROLE_OVERLAP",
    );
  });

  it("revoked rows do not participate in the disjoint check", () => {
    const ctx = makeCtx("fd-revoked");
    const A = addModel(ctx, "gemini", "a");
    const B = addModel(ctx, "groq", "b");
    assignModelRole(ctx.store, String(A.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR);
    revokeModelRole(ctx.store, String(A.model_entry_id));
    assignModelRole(ctx.store, String(B.model_entry_id), MODEL_ROLE.DSH_EXECUTION);
    expect(() => assertCanonicalModelRoleStateDisjoint(ctx.store)).not.toThrow();
  });
});
