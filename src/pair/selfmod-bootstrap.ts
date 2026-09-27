/**
 * P9 selfmod worktree bootstrap — deterministic environment bring-up for an
 * isolated self-improvement worktree: exact lockfile install, shared
 * immutable pnpm store, no mutation of the lockfile or the canonical repo.
 *
 * Injectable command runner keeps tests deterministic; the default runner
 * executes `pnpm install --frozen-lockfile` inside the worktree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairControlPlane } from "./service.js";

export interface BootstrapRunner {
  run(cmd: string, args: string[], cwd: string): { code: number; out: string };
}

const defaultRunner: BootstrapRunner = {
  run(cmd, args, cwd) {
    try {
      const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out: String(out).slice(0, 4000) };
    } catch (error) {
      const e = error as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
      return {
        code: Number(e.status ?? 1),
        out: `${String(e.stdout ?? "")}\n${String(e.stderr ?? e.message ?? "")}`.slice(0, 4000),
      };
    }
  },
};

export class SelfmodBootstrap {
  constructor(
    private readonly service: PairControlPlane,
    private readonly runner: BootstrapRunner = defaultRunner,
    private readonly storeDir?: string,
  ) {}

  /**
   * Bootstrap a selfmod worktree deterministically.
   * Refuses when the worktree is missing or has no lockfile (fail closed).
   */
  bootstrap(worktreePath: string, changeId: string): Record<string, unknown> {
    const abs = path.resolve(worktreePath);
    if (!fs.existsSync(abs)) {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_WORKTREE_MISSING", abs);
    }
    const lockfile = path.join(abs, "pnpm-lock.yaml");
    const hasLockfile = fs.existsSync(lockfile);
    const steps: Array<{ step: string; pass: boolean; detail: string }> = [];

    // 1. Lockfile must be present — bootstrap never mutates dependency pins.
    if (!hasLockfile) {
      steps.push({ step: "lockfile_present", pass: false, detail: "pnpm-lock.yaml absent" });
      return this.persist(changeId, abs, steps, false);
    }
    steps.push({ step: "lockfile_present", pass: true, detail: "pnpm-lock.yaml" });

    // 2. Frozen install — shared immutable store when configured.
    const args = ["install", "--frozen-lockfile"];
    if (this.storeDir) {
      fs.mkdirSync(this.storeDir, { recursive: true });
      args.push("--store-dir", this.storeDir);
    }
    const install = this.runner.run("pnpm", args, abs);
    steps.push({
      step: "pnpm_install_frozen",
      pass: install.code === 0,
      detail: install.out.slice(-500),
    });

    // 3. Deterministic env check: node_modules created.
    const ok = install.code === 0 && fs.existsSync(path.join(abs, "node_modules"));
    if (install.code === 0) {
      steps.push({ step: "node_modules_present", pass: ok, detail: ok ? "present" : "missing after install" });
    }
    const pass = steps.every((s) => s.pass);
    return this.persist(changeId, abs, steps, pass);
  }

  private persist(
    changeId: string,
    worktreePath: string,
    steps: Array<{ step: string; pass: boolean; detail: string }>,
    pass: boolean,
  ) {
    const receipt = {
      receipt_id: `BST_${changeId}`,
      change_id: changeId,
      worktree_path: worktreePath,
      steps,
      pass,
      created_at: utcnow(),
      version: 0,
    };
    (receipt as Record<string, unknown>).receipt_digest = digest(receipt);
    this.service.store.put("selfmod_bootstrap", receipt.receipt_id, receipt, 0);
    this.service.store.event({
      entity_type: "selfmod_bootstrap",
      entity_id: receipt.receipt_id,
      event_type: pass ? "SELFMOD_BOOTSTRAP_COMPLETED" : "SELFMOD_BOOTSTRAP_FAILED",
      new_state: pass ? "READY" : "FAILED",
      actor: "PAIR_SELFMOD_BOOTSTRAP",
      metadata: { change_id: changeId, pass },
    });
    return receipt;
  }
}
