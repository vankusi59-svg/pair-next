import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITY_IDS } from "../pair/codex-adapter.js";
import { DSH_CAPABILITY_IDS } from "../pair/dsh-adapter.js";

/**
 * Ops hotfix 2026-10-01 — a TELEGRAM_DELIVERY task that fails on DSH must
 * have at least one alternate eligible executor or recovery RE_ROUTE throws
 * FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR on every tick (supervisor swallows it →
 * mission stuck RECOVERING forever, seen live on MSN_01M3VHGS6HPA62V6K9JR57MNEK).
 *
 * CODEX is the chosen fallback: it runs the same buildGovernedPrompt path as
 * DSH (dependency_outputs injected, workspace write access) so it can compose
 * the outbox deliverable semantically. DEVIN was rejected — its remote
 * buildPrompt never injects dependency_outputs, so it could not compose the
 * report, and remote execution costs ACU for a trivial task.
 */
describe("TELEGRAM_DELIVERY reroute coverage", () => {
  it("DSH declares TELEGRAM_DELIVERY (unchanged baseline)", () => {
    expect(DSH_CAPABILITY_IDS).toContain("TELEGRAM_DELIVERY");
  });

  it("CODEX declares TELEGRAM_DELIVERY (local LLM fallback)", () => {
    expect(CODEX_CAPABILITY_IDS).toContain("TELEGRAM_DELIVERY");
  });

  it("at least two executors can serve TELEGRAM_DELIVERY (re-route has an alternate)", () => {
    const catalogs = [DSH_CAPABILITY_IDS, CODEX_CAPABILITY_IDS];
    const count = catalogs.filter((c) => (c as readonly string[]).includes("TELEGRAM_DELIVERY")).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
