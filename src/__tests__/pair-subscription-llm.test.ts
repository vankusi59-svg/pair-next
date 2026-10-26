/**
 * PR #120 — Subscription-Only LLM Policy: focused regressions.
 *
 * The ONLY permitted production LLM transport for the three reasoning
 * lanes — Planner (INITIAL + REPLAN), LLM CEO, Conversation Reasoning —
 * is the authenticated Codex CLI / ChatGPT subscription session
 * (`codex-cli:<model>` routes over the shared codex-cli-transport).
 * There is no HTTP/API fallback: not on unavailability, rate limits,
 * quota exhaustion, logout, model unavailability, or timeout.
 *
 * S1 route-compose policy (production function objects — the same
 *    compose+assert seam serve-mission-control.mjs runs at boot):
 *    only `codex-cli:*` may configure the planner pool; a non-codex
 *    route in ANY of PAIR_PLANNER_MODEL_ROUTE / FALLBACK / EXTRA_ROUTES
 *    fails closed BEFORE provider discovery or a single HTTP probe.
 * S2 invocation-seam policy: assertCodexCliPlannerTransport is the gate
 *    the production planFn runs first; a runtime-forged non-codex
 *    candidate dies as an authority violation, never an HTTP request.
 * S3 bounded codex failure behavior: quota/rate-limit exhaustion
 *    fails over ONLY within the codex pool, then EXHAUSTED — never a
 *    metered fallback activation.
 * S4 INITIAL and REPLAN run the SAME codex-only pool composition.
 * S5 LLM CEO: the production CodexCliCeoDecisionInvoker refuses a
 *    forged non-codex transport BEFORE executable resolution/spawn.
 * S6 Conversation Reasoning: resolveConversationModelTransport +
 *    CodexCliConversationInvoker refuse non-codex providers; the same
 *    invoker serves Dashboard Chat and Telegram replies.
 * S7 subscription auth surface: codexCliChildEnv never forwards
 *    OPENAI_API_KEY / CODEX_API_KEY to a reasoning child.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  assertCodexOnlyPlannerRoute,
  assertCodexCliPlannerTransport,
  codexCliChildEnv,
  codexCliProviderCandidate,
  ProviderCatalog,
  ensureCodexCliCatalog,
  resolveConversationModelTransport,
  CodexCliConversationInvoker,
  CodexCliCeoDecisionInvoker,
  composeConfiguredRoleRoutes,
  dedupePlannerCandidates,
  runPlannerFailover,
  IntegrityError,
  ModelEvidenceCatalog,
  PairEvidenceStore,
  PLANNER_FAILURE_CLASS,
  canonicalModelId,
  type PlannerCandidate,
} from "../pair/index.js";

const FAIL = "FAIL_CLOSED_PLANNER_TRANSPORT_UNAUTHORIZED";
const code = (e: unknown) => String((e as { code?: string })?.code ?? "");

function throwsCode(fn: () => unknown, want: string) {
  try {
    fn();
  } catch (e) {
    expect(code(e)).toBe(want);
    return;
  }
  expect.unreachable(`expected throw ${want}`);
}

async function rejectsCode(p: Promise<unknown>, want: string) {
  try {
    await p;
  } catch (e) {
    expect(code(e)).toBe(want);
    return;
  }
  expect.unreachable(`expected rejection ${want}`);
}

/* ============================= S1 ============================= */

describe("S1 — planner route-compose policy (production seam)", () => {
  const compose = (opts: {
    primary?: string;
    fallback?: string | null;
    extras?: string | null;
  }) =>
    composeConfiguredRoleRoutes({
      primary: opts.primary ?? "codex-cli:gpt-6.1-sol",
      fallback: opts.fallback ?? "",
      extras: opts.extras ?? null,
    }).map(assertCodexOnlyPlannerRoute);

  it("S1.1 accepts codex-cli routes (trimmed, deduplicated)", () => {
    expect(assertCodexOnlyPlannerRoute("  codex-cli:gpt-6.1-sol ")).toBe(
      "codex-cli:gpt-6.1-sol",
    );
    expect(
      compose({ extras: "codex-cli:gpt-6.1-mini,codex-cli:gpt-6.1-sol" }),
    ).toEqual(["codex-cli:gpt-6.1-sol", "codex-cli:gpt-6.1-mini"]);
  });

  it("S1.2 rejects every non-codex route shape", () => {
    for (const bad of [
      "gemini:gemini-3.1-flash-lite",
      "openai:gpt-5",
      "anthropic:claude-4",
      "dsh:deepseek-chat",
      "codex-cli:",          // bare provider, no model
      "codex-cli",           // no separator
      "gpt-6.1-sol",         // no provider
      " http://x ",          // endpoint, not a route
      "",
    ]) {
      throwsCode(() => assertCodexOnlyPlannerRoute(bad), FAIL);
    }
  });

  it("S1.3 fresh production defaults → exactly one codex candidate", () => {
    // Mirror of serve-mission-control.mjs: primary default codex, the
    // Gemini default fallback REMOVED, extras unset.
    expect(compose({})).toEqual(["codex-cli:gpt-6.1-sol"]);
  });

  it("S1.4 non-codex PRIMARY rejected before any HTTP request", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      throwsCode(() => compose({ primary: "gemini:gemini-3.1-flash-lite" }), FAIL);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("S1.5 non-codex FALLBACK rejected before any HTTP request", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      throwsCode(
        () => compose({ fallback: "gemini:gemini-3.1-flash-lite" }),
        FAIL,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("S1.6 non-codex EXTRA rejected before any HTTP request", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      throwsCode(
        () =>
          compose({
            fallback: "codex-cli:gpt-6.1-mini",
            extras: "codex-cli:gpt-6.1-nano,openai:gpt-5",
          }),
        FAIL,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("S1.7 an explicitly empty primary fails closed — no silent substitute", () => {
    throwsCode(() => compose({ primary: "   " }), FAIL);
  });
});

/* ============================= S2 ============================= */

describe("S2 — invocation-seam transport gate", () => {
  const codex: PlannerCandidate = {
    model_entry_id: canonicalModelId("codex-cli", "gpt-6.1-sol"),
    ref: "codex-cli:gpt-6.1-sol",
    provider: "codex-cli",
    model: "gpt-6.1-sol",
    endpoint: "codex-cli://local",
    credentialEnv: "",
    transport: "codex_cli",
  };

  it("S2.1 codex_cli passes; every other transport fails closed", () => {
    expect(() => assertCodexCliPlannerTransport(codex)).not.toThrow();
    for (const t of ["openai_http", undefined, "http", ""] as const) {
      throwsCode(
        () => assertCodexCliPlannerTransport({ ref: "gemini:x", transport: t }),
        FAIL,
      );
    }
  });

  it("S2.2 a forged HTTP candidate in the pool dies at planFn — never an HTTP invocation", async () => {
    const httpInvocations: string[] = [];
    const forged: PlannerCandidate = {
      model_entry_id: "ME_forged",
      ref: "gemini:gemini-3.1-flash-lite",
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      endpoint: "https://api.gemini.test/v1",
      credentialEnv: "GEMINI_API_KEY",
      transport: "openai_http",
    };
    // planFn mirrors serve-mission-control.mjs: the production gate
    // runs FIRST; anything else would be an HTTP call (counted here).
    await expect(
      runPlannerFailover({
        candidates: [codex, forged],
        assertEligible: () => undefined,
        planFn: async (c, _inv) => {
          assertCodexCliPlannerTransport(c);
          if (c.transport !== "codex_cli") {
            httpInvocations.push(c.ref); // guard marker — never reached
          }
          return { tasks: [], warnings: ["CODEX_RATE_LIMITED"] };
        },
      }),
    ).rejects.toMatchObject({ code: FAIL });
    expect(httpInvocations).toEqual([]);
  });
});

/* ============================= S3 ============================= */

describe("S3 — codex exhaustion: bounded failure, never a metered fallback", () => {
  const c = (mid: string): PlannerCandidate => ({
    model_entry_id: canonicalModelId("codex-cli", mid),
    ref: `codex-cli:${mid}`,
    provider: "codex-cli",
    model: mid,
    endpoint: "codex-cli://local",
    credentialEnv: "",
    transport: "codex_cli",
  });

  it("S3.1 quota/rate-limit exhausts a codex-only pool — EXHAUSTED, one attempt", async () => {
    const invoked: string[] = [];
    const err = await runPlannerFailover({
      candidates: [c("gpt-6.1-sol")],
      assertEligible: () => undefined,
      planFn: async (candidate) => {
        invoked.push(candidate.ref);
        // The codex transport's typed quota signal (classified
        // QUOTA_RATE_LIMITED by classifyPlannerFailure).
        return { tasks: [], warnings: ["CODEX_RATE_LIMITED"] };
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(code(err)).toBe("FAIL_CLOSED_PLANNER_EXHAUSTED");
    // The one codex attempt ran once and typed QUOTA_RATE_LIMITED; no
    // second candidate exists to silently take over.
    expect(invoked).toEqual(["codex-cli:gpt-6.1-sol"]);
    const detail = JSON.parse(String((err as { detail?: string }).detail)) as {
      routes: Array<{ failure_class?: string }>;
    };
    expect(detail.routes).toHaveLength(1);
    expect(detail.routes[0].failure_class).toBe(
      PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED,
    );
  });

  it("S3.2 bounded failover stays inside the codex pool", async () => {
    const invoked: string[] = [];
    const res = await runPlannerFailover({
      candidates: [c("gpt-6.1-sol"), c("gpt-6.1-mini")],
      assertEligible: () => undefined,
      planFn: async (candidate) => {
        invoked.push(candidate.ref);
        return candidate.model === "gpt-6.1-sol"
          ? { tasks: [], warnings: ["CODEX_RATE_LIMITED"] }
          : { tasks: [{ task_key: "T1" }], warnings: [] };
      },
    });
    expect(res.winner.model).toBe("gpt-6.1-mini");
    expect(invoked).toEqual(["codex-cli:gpt-6.1-sol", "codex-cli:gpt-6.1-mini"]);
    expect(res.attempts[0].failure_class).toBe(
      PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED,
    );
  });
});

/* ============================= S4 ============================= */

describe("S4 — INITIAL and REPLAN obey the same codex-only pool", () => {
  const candidates: PlannerCandidate[] = dedupePlannerCandidates([
    {
      model_entry_id: canonicalModelId("codex-cli", "gpt-6.1-sol"),
      ref: "codex-cli:gpt-6.1-sol",
      provider: "codex-cli",
      model: "gpt-6.1-sol",
      endpoint: "codex-cli://local",
      credentialEnv: "",
      transport: "codex_cli",
    },
    {
      model_entry_id: canonicalModelId("codex-cli", "gpt-6.1-mini"),
      ref: "codex-cli:gpt-6.1-mini",
      provider: "codex-cli",
      model: "gpt-6.1-mini",
      endpoint: "codex-cli://local",
      credentialEnv: "",
      transport: "codex_cli",
    },
  ]);

  it("S4.1 the same candidate array drives both lanes — codex only, twice", async () => {
    // serve-mission-control.mjs passes THE SAME `plannerCandidates`
    // array through dedupePlannerCandidates to planExpander (INITIAL)
    // and runReplanPoolGeneration (REPLAN). This exercises the shared
    // failover composition both ways; only codex transport may invoke.
    const seen: string[] = [];
    const run = (replan: boolean) =>
      runPlannerFailover({
        candidates,
        assertEligible: () => undefined,
        planFn: async (candidate) => {
          assertCodexCliPlannerTransport(candidate);
          seen.push(`${replan ? "REPLAN" : "INITIAL"}:${candidate.ref}`);
          return { tasks: [{ task_key: "T1" }], warnings: [] };
        },
      });
    await expect(run(false)).resolves.toBeTruthy();
    await expect(run(true)).resolves.toBeTruthy();
    expect(seen).toEqual([
      "INITIAL:codex-cli:gpt-6.1-sol",
      "REPLAN:codex-cli:gpt-6.1-sol",
    ]);
  });

  it("S4.2 dedupe preserves the codex-only invariant", () => {
    expect(candidates.every((x) => x.transport === "codex_cli")).toBe(true);
    expect(candidates.every((x) => x.provider === "codex-cli")).toBe(true);
  });
});

/* ============================= S5 ============================= */

describe("S5 — LLM CEO: CodexCliCeoDecisionInvoker refuses non-codex transport", () => {
  const forged = {
    model_entry_id: "ME_forged",
    provider_id: "openai",
    provider_family: "openai",
    model_id: "gpt-5",
    protocol_family: "OPENAI_COMPATIBLE",
  };

  it("S5.1 a forged transport fails BEFORE executable resolution or spawn", async () => {
    const invoker = new CodexCliCeoDecisionInvoker({ env: {} });
    await rejectsCode(
      invoker.invoke({
        transport: forged,
        system_prompt: "s",
        user_prompt: "u",
        observation_digest: "d",
      }),
      "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT",
    );
  });
});

/* ============================= S6 ============================= */

describe("S6 — Conversation Reasoning: codex-only, both chat surfaces", () => {
  let dir: string;
  let store: PairEvidenceStore;

  beforeEach(() => {
    dir = mkTmpDir("pair-sub-llm-");
    store = new PairEvidenceStore(path.join(dir, "pair.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("S6.1 a codex model_entry resolves to the codex transport identity", () => {
    const meId = ensureCodexCliCatalog(store, "gpt-6.1-sol", "TEST");
    const t = resolveConversationModelTransport(store, meId);
    expect(t.provider_id).toBe("codex-cli");
    expect(t.protocol_family).toBe("CODEX_CLI");
  });

  it("S6.2 a model_entry owned by a non-codex provider fails closed at resolve", () => {
    // Seed a foreign HTTP provider + model_entry through the canonical
    // catalog seams (no probes needed — resolve reads canonical rows).
    const pid = "openai-http";
    new ProviderCatalog(store).upsertCandidate(
      {
        provider_native_id: pid,
        canonical_hint: pid,
        source_id: "OPERATOR_MANIFEST",
        display_name: pid,
        provider_type: "OPENAI_COMPATIBLE",
        protocol_family: "OPENAI_COMPATIBLE",
        provider_family: pid,
        endpoint_reference: `https://api.${pid}.test/v1`,
        credential_reference_name: "OPENAI_HTTP_KEY",
      },
      "TEST",
    );
    const { entry } = new ModelEvidenceCatalog(store).upsertModelClaim({
      provider_id: pid,
      provider_family: pid,
      model_id: "gpt-5",
      display_name: "gpt-5",
      capability_hints: ["text_inference"],
    }, "TEST");
    throwsCode(
      () => resolveConversationModelTransport(store, String(entry.model_entry_id)),
      "FAIL_CLOSED_CONVERSATION_NON_CODEX_TRANSPORT",
    );
  });

  it("S6.3 a forged transport fails the production invoker BEFORE spawn", async () => {
    // The SAME CodexCliConversationInvoker instance serves Dashboard
    // Chat and Telegram replies — one transport authority for both.
    const invoker = new CodexCliConversationInvoker({ env: {} });
    await rejectsCode(
      invoker.invoke({
        transport: {
          model_entry_id: "ME_forged",
          provider_id: "openai",
          provider_family: "openai",
          model_id: "gpt-5",
          protocol_family: "OPENAI_COMPATIBLE",
        },
        system_prompt: "s",
        user_prompt: "u",
      }),
      "FAIL_CLOSED_CONVERSATION_NON_CODEX_TRANSPORT",
    );
  });
});

/* ============================= S7 ============================= */

describe("S7 — subscription auth surface: no metered credential reaches a child", () => {
  it("S7.1 codexCliChildEnv strips OPENAI_API_KEY / CODEX_API_KEY", () => {
    const env = codexCliChildEnv({
      PATH: "/bin",
      CODEX_HOME: "/home/u/.codex",
      OPENAI_API_KEY: "sk-metered",
      CODEX_API_KEY: "ck-metered",
      ANTHROPIC_API_KEY: "ak-metered",
      GEMINI_API_KEY: "gk-metered",
    });
    expect(env.CODEX_HOME).toBe("/home/u/.codex");
    expect(env.PATH).toBe("/bin");
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect("CODEX_API_KEY" in env).toBe(false);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect("GEMINI_API_KEY" in env).toBe(false);
  });

  it("S7.2 the codex provider candidate is the CLI transport identity", () => {
    const c = codexCliProviderCandidate();
    expect(c.provider_native_id).toBe("codex-cli");
    expect(c.protocol_family).toBe("CODEX_CLI");
    expect(String(c.endpoint_reference)).toBe("codex-cli://local");
    expect(c.credential_reference_name).toBeNull();
    expect(c.credential_envs).toEqual([]);
  });
});
