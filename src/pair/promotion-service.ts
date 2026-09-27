/**
 * P9 governed promotion service — the ONLY path that lands a self-improvement
 * patch on the canonical branch. Promotion is operator-gated and fully
 * verified before any merge:
 *
 *   1. promotion_candidate exists with approval_status=APPROVED via the
 *      ApprovalQueue (SELFMOD_PROMOTION_APPROVAL bound to the exact scope
 *      digest — approval can never be reused for a changed scope),
 *   2. candidate's parent_commit still matches the canonical HEAD,
 *   3. validation + verifier receipts exist and all passed,
 *   4. canonical repo working tree is clean,
 *   5. candidate patch digest re-verified against the stored digest,
 *   6. explicit deterministic `git cherry-pick <candidate_commit>` — never
 *      a silent merge, never auto-promotion.
 *
 * Every step (and every refusal) is persisted as a `promotion_receipt`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { ApprovalQueue } from "./approval-queue.js";

export interface GitRunner {
  run(args: string[], cwd: string): { code: number; out: string };
}

const defaultGit: GitRunner = {
  run(args, cwd) {
    try {
      const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out: String(out).trim() };
    } catch (error) {
      const e = error as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
      return { code: Number(e.status ?? 1), out: `${String(e.stdout ?? "")}\n${String(e.stderr ?? e.message ?? "")}`.trim() };
    }
  },
};

export class PromotionService {
  constructor(
    private readonly service: PairControlPlane,
    private readonly approvals: ApprovalQueue,
    private readonly repoRoot: string,
    private readonly git: GitRunner = defaultGit,
  ) {}

  private get store() {
    return this.service.store;
  }

  private reject(receipt: Record<string, unknown>, why: string): Record<string, unknown> {
    receipt.status = "REJECTED";
    receipt.rejection = why;
    receipt.version = Number(receipt.version ?? 0) + 1;
    this.store.put("promotion_receipt", String(receipt.receipt_id), receipt, Number(receipt.version));
    throw new PolicyError("FAIL_CLOSED_PROMOTION_VERIFICATION", why);
  }

  /**
   * Promote an APPROVED promotion candidate. `approvalScope` must re-digest
   * to the SELFMOD_PROMOTION_APPROVAL approval's scope_digest — callers must
   * present the exact approved scope.
   */
  promote(
    promotionId: string,
    operatorId: string,
    approvalScope: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!operatorId) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "promotion");
    }
    const candidate = this.store.get("promotion_candidate", promotionId);
    const receipt: Record<string, unknown> = {
      receipt_id: newId("PRCR"),
      promotion_id: promotionId,
      change_id: candidate.change_id,
      operator_id: operatorId,
      checks: [] as Array<{ check: string; pass: boolean; detail: string }>,
      status: "PENDING",
      created_at: utcnow(),
      version: 0,
    };
    this.store.put("promotion_receipt", String(receipt.receipt_id), receipt, 0);
    const check = (name: string, pass: boolean, detail: string) => {
      (receipt.checks as Array<Record<string, unknown>>).push({ check: name, pass, detail });
      if (!pass) this.reject(receipt, `${name}:${detail}`);
    };

    // 1. Operator approval already recorded on the candidate.
    check(
      "candidate_approved",
      candidate.approval_status === "APPROVED",
      String(candidate.approval_status),
    );
    // 2. ApprovalQueue scope binding — the presented scope must match an
      //    approved SELFMOD_PROMOTION_APPROVAL digest.
    const scopeDigest = digest(approvalScope);
    const approval = this.approvals.approvedFor(scopeDigest, "SELFMOD_PROMOTION_APPROVAL");
    check("approval_scope_bound", Boolean(approval), approval ? String(approval.approval_id) : "no matching approval");
    // 3. Validation + verifier receipts all passed.
    const validations = (candidate.validation_receipts as Array<Record<string, unknown>>) ?? [];
    check(
      "validation_receipts_pass",
      validations.length > 0 && validations.every((r) => r.pass === true),
      `${validations.length} receipts`,
    );
    // 4. Candidate parent matches canonical HEAD — no drift promotion.
    const head = this.git.run(["rev-parse", "HEAD"], this.repoRoot);
    check("head_resolved", head.code === 0, head.out);
    check(
      "parent_matches_head",
      String(candidate.parent_commit) === head.out,
      `parent=${String(candidate.parent_commit).slice(0, 8)} head=${head.out.slice(0, 8)}`,
    );
    // 5. Canonical working tree clean — promotion never merges into dirt.
    const status = this.git.run(["status", "--porcelain"], this.repoRoot);
    check("canonical_tree_clean", status.code === 0 && status.out === "", status.out.slice(0, 200));
    // 6. Re-verify candidate patch digest from the worktree diff.
    const c = this.store.get("selfmod_candidate", String(candidate.change_id));
    if (c.worktree_path && fs.existsSync(String(c.worktree_path))) {
      const diff = this.git.run(
        ["-C", String(c.worktree_path), "diff", String(c.parent_commit), String(c.candidate_commit)],
        this.repoRoot,
      );
      const reDigest = digest({ parent: c.parent_commit, diff: diff.out });
      check("candidate_digest_verified", reDigest === candidate.patch_digest, reDigest.slice(0, 12));
    } else {
      check("candidate_digest_verified", false, "worktree missing");
    }
    // 7. Explicit deterministic cherry-pick of the pinned candidate commit.
    const pick = this.git.run(
      ["cherry-pick", "--no-commit", String(candidate.candidate_commit)],
      this.repoRoot,
    );
    if (pick.code !== 0) {
      this.git.run(["cherry-pick", "--abort"], this.repoRoot);
      check("cherry_pick_applied", false, pick.out.slice(0, 300));
    }
    const commit = this.git.run(
      ["-c", "user.email=pair-promotion@local", "-c", "user.name=pair-promotion",
        "commit", "-m", `promotion ${String(promotionId)} (${String(candidate.change_id)})`],
      this.repoRoot,
    );
    if (commit.code !== 0) {
      this.git.run(["cherry-pick", "--abort"], this.repoRoot);
      check("promotion_commit_created", false, commit.out.slice(0, 300));
    }
    const newHead = this.git.run(["rev-parse", "HEAD"], this.repoRoot);
    check("promotion_commit_created", commit.code === 0, newHead.out.slice(0, 12));

    receipt.status = "MERGED";
    receipt.merged_commit = newHead.out;
    receipt.merged_at = utcnow();
    receipt.version = Number(receipt.version ?? 0) + 1;
    this.store.put("promotion_receipt", String(receipt.receipt_id), receipt, Number(receipt.version));
    // Mark the promotion candidate merged; candidate entity stays APPR+merged.
    this.store.put("promotion_candidate", promotionId, {
      ...candidate,
      merged: true,
      merged_commit: newHead.out,
      promotion_receipt_id: receipt.receipt_id,
    }, Number(candidate.version));
    this.store.event({
      entity_type: "promotion_candidate",
      entity_id: promotionId,
      event_type: "PROMOTION_MERGED",
      new_state: "MERGED",
      actor: `OPERATOR:${operatorId}`,
      metadata: { merged_commit: newHead.out, receipt_id: receipt.receipt_id },
    });
    return receipt;
  }
}
