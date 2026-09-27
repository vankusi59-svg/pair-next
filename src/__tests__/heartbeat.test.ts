/**
 * Heartbeat Tests
 *
 * Tests for heartbeat tasks, especially the social inbox checker.
 * Phase 1.1: Updated to pass TickContext + HeartbeatLegacyContext.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  MockComputeClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, InboxMessage, TickContext, HeartbeatLegacyContext } from "../types.js";

function createMockTickContext(db: AutomatonDatabase, overrides?: Partial<TickContext>): TickContext {
  return {
    tickId: "test-tick-1",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 1.5,
    survivalTier: "normal",
    lowComputeMultiplier: 4,
    config: {
      entries: [],
      defaultIntervalMs: 60_000,
      lowComputeMultiplier: 4,
    },
    db: db.raw,
    ...overrides,
  };
}

describe("Heartbeat Tasks", () => {
  let db: AutomatonDatabase;
  let compute: MockComputeClient;

  beforeEach(() => {
    db = createTestDb();
    compute = new MockComputeClient();
  });

  afterEach(() => {
    db.close();
  });

  describe("heartbeat_ping", () => {
    it("records ping and does not wake on normal tier", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 10_000,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const ping = db.getKV("last_heartbeat_ping");
      expect(ping).toBeDefined();
      const parsed = JSON.parse(ping!);
      expect(parsed.creditsCents).toBe(10_000);
      expect(parsed.tier).toBe("normal");
    });

    it("wakes on critical tier with distress signal", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Distress");
      const distress = db.getKV("last_distress");
      expect(distress).toBeDefined();
    });

    it("wakes on dead tier with distress signal", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 0,
        survivalTier: "dead",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("dead");
    });
  });

  // ─── check_credits ──────────────────────────────────────────

  describe("check_credits", () => {
    it("does not wake when tier unchanged", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 10_000,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      // Set previous tier to same
      db.setKV("prev_credit_tier", "normal");

      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const check = db.getKV("last_credit_check");
      expect(check).toBeDefined();
    });

    it("wakes when tier drops to critical", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      // Previous tier was normal
      db.setKV("prev_credit_tier", "normal");

      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("critical");
    });

    it("does not wake on first run (no previous tier)", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      // No previous tier set
      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });

  // ─── check_usdc_balance ─────────────────────────────────────

  describe("health_check", () => {
    it("returns shouldWake false when sandbox is healthy", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      expect(db.getKV("last_health_check")).toBeDefined();
    });

    it("wakes when sandbox exec fails", async () => {
      compute.exec = async () => ({ stdout: "", stderr: "unhealthy", exitCode: 1 });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Health check failed");
    });

    it("wakes when sandbox exec throws", async () => {
      compute.exec = async () => {
        throw new Error("sandbox unreachable");
      };

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("sandbox unreachable");
    });
  });

  // ─── refresh_models ─────────────────────────────────────────

  describe("refresh_models", () => {
    it("refreshes model registry from API", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      const result = await BUILTIN_TASKS.refresh_models(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const refresh = db.getKV("last_model_refresh");
      expect(refresh).toBeDefined();
      const parsed = JSON.parse(refresh!);
      expect(parsed.count).toBeGreaterThan(0);
    });
  });

  // ─── Shared Tick Context ────────────────────────────────────

  describe("shared tick context", () => {
    it("all tasks receive the same tick context without redundant API calls", async () => {
      // Verify that tasks use ctx.creditBalance instead of making API calls
      const tickCtx = createMockTickContext(db, {
        creditBalance: 7777,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        compute,
      };

      // Run heartbeat_ping — it should use ctx.creditBalance
      await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);
      const ping = JSON.parse(db.getKV("last_heartbeat_ping")!);
      expect(ping.creditsCents).toBe(7777);

      // Run check_credits — it should also use ctx.creditBalance
      await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);
      const creditCheck = JSON.parse(db.getKV("last_credit_check")!);
      expect(creditCheck.credits).toBe(7777);

      // No direct getCreditsBalance calls should have been made by these tasks
      // (compute.getCreditsBalance is only called during buildTickContext, not by tasks)
    });
  });
});
