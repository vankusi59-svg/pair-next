/**
 * ArtifactProvenanceValidator port (donor artifact_validation.py).
 *
 * Terminal validation boundary: every declared artifact must exist, live
 * inside governed allowed_paths, and match its declared sha256 + byte_size.
 * Batch-validate-then-persist: a single failure rejects the whole result
 * and no artifact entity is written.
 */

import fs from "node:fs";
import path from "node:path";
import { boundedFileSha256, newId, pathWithin, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { MAX_ARTIFACT_BYTES } from "./artifact-authority.js";
import type { PairControlPlane } from "./service.js";

export class ArtifactProvenanceValidator {
  validate_execution(
    service: PairControlPlane,
    executionId: string,
  ): Record<string, unknown> {
    const store = service.store;
    const execution = store.get("executor_execution", executionId);
    const governed = store.get("governed_task", String(execution.governed_task_id));
    const result = execution.result as Record<string, unknown> | undefined;
    const workspace = String(governed.workspace);
    const allowedPaths = (governed.allowed_paths as string[]) ?? [workspace];

    const artifacts =
      (result?.artifacts as Array<Record<string, unknown>> | undefined) ?? [];
    const status = String(result?.status ?? "FAILED");

    const validationId = newId("XVLD");
    const failures: string[] = [];

    // Result-state gate: a non-COMPLETED result may never carry validated artifacts.
    const checkedArtifacts: Array<Record<string, unknown>> = [];
    for (const art of artifacts) {
      const rel = String(art.path ?? "");
      if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) {
        failures.push(`artifact path invalid: ${rel || "<empty>"}`);
        continue;
      }
      const abs = path.resolve(workspace, rel);
      if (!allowedPaths.some((ap) => pathWithin(abs, ap))) {
        failures.push(`artifact outside allowed_paths: ${rel}`);
        continue;
      }
      if (!fs.existsSync(abs)) {
        failures.push(`artifact missing: ${rel}`);
        continue;
      }
      // F1 §9: no symlink may mint canonical artifact authority.
      if (fs.lstatSync(abs).isSymbolicLink()) {
        failures.push(`artifact symlink: ${rel}`);
        continue;
      }
      // F1: stat-first bounded read — an oversized artifact is rejected
      // before any unbounded materialization.
      const br = boundedFileSha256(abs, MAX_ARTIFACT_BYTES);
      if (br.kind === "too_large") {
        failures.push(`artifact too large: ${rel}`);
        continue;
      }
      if (br.kind !== "ok") {
        failures.push(`artifact unresolved: ${rel}`);
        continue;
      }
      const actualSha = br.sha256;
      const actualSize = br.size;
      if (art.sha256 && String(art.sha256) !== actualSha) {
        failures.push(`artifact sha256 mismatch: ${rel}`);
        continue;
      }
      if (art.byte_size !== undefined && Number(art.byte_size) !== actualSize) {
        failures.push(`artifact byte_size mismatch: ${rel}`);
        continue;
      }
      checkedArtifacts.push({ ...art, sha256: actualSha, byte_size: actualSize });
    }

    let pass = failures.length === 0 && status === "COMPLETED";
    if (!pass && status === "COMPLETED" && failures.length === 0) {
      failures.push("non-completed result cannot pass validation");
      pass = false;
    }

    // F1 §5 + R1.6 — local artifacts converge through the ONE canonical
    // ingest seam as a SINGLE atomic batch: PASS means every required
    // canonical authority committed; FAIL mints ZERO new ART rows (a
    // prefix of accepted artifacts can never survive a failed
    // validation). Previously accepted remote-upload artifacts persist
    // (they are already canonical) but are not re-minted here.
    let acceptedIds: string[] = [];
    if (pass && checkedArtifacts.length) {
      try {
        const batch = service.artifacts.acceptBatch({
          execution_id: executionId,
          producer_executor_id: String(execution.executor_id),
          items: checkedArtifacts.map((art) => ({
            logical_name: String(art.path),
            source: {
              kind: "path" as const,
              path: path.resolve(workspace, String(art.path)),
            },
          })),
          channel: "LOCAL_EXECUTION",
          actor: "PAIR_ARTIFACT_VALIDATOR",
          correlation_id: String(execution.correlation_id),
          allow_post_result: true,
        });
        acceptedIds = batch.artifacts.map((a) => String(a.artifact_id));
      } catch (e) {
        failures.push(
          `artifact ingest rejected: ${e instanceof IntegrityError ? e.code : String(e)}`,
        );
        pass = false;
      }
    }
    // F1 §7 — remote executions return artifacts:[] adapter-side, but
    // capability-bound uploads already minted canonical ART_* rows.
    // Restart/re-observation reconstructs the same references from
    // durable state — no re-upload, no re-baselining.
    if (pass) {
      const remoteIds = service.artifacts
        .forExecution(executionId)
        .map((a) => String(a.artifact_id))
        .filter((id) => !acceptedIds.includes(id));
      acceptedIds.push(...remoteIds);
    } else {
      // R1.6 — a FAIL exposes zero new local authority; prior remote
      // references are diagnostics, not PASS authority, so they move to
      // a separate non-authoritative field.
      acceptedIds = [];
    }

    const validation = store.put(
      "execution_validation",
      validationId,
      {
        validation_id: validationId,
        execution_id: executionId,
        governed_task_id: governed.governed_task_id,
        mission_id: execution.mission_id,
        status: pass ? "PASS" : "FAIL",
        failures,
        artifact_count: checkedArtifacts.length,
        artifact_ids: acceptedIds,
        referenced_artifact_ids: service.artifacts
          .forExecution(executionId)
          .map((a) => String(a.artifact_id)),
        created_at: utcnow(),
        version: 0,
      },
      0,
    );
    store.event({
      entity_type: "executor_execution",
      entity_id: executionId,
      event_type: pass ? "RESULT_VALIDATED" : "RESULT_VALIDATION_FAILED",
      new_state: pass ? "PASS" : "FAIL",
      actor: "PAIR_ARTIFACT_VALIDATOR",
      correlation_id: String(execution.correlation_id),
      metadata: { validation_id: validationId, failures },
    });
    store.appendEvidence(String(execution.mission_id), "RESULT_VALIDATION", {
      execution_id: executionId,
      validation_id: validationId,
      status: pass ? "PASS" : "FAIL",
      failures,
    });
    return validation;
  }
}
