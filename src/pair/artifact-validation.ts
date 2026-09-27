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
import { newId, pathWithin, sha256File, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
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
      const actualSha = sha256File(abs);
      const actualSize = fs.statSync(abs).size;
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

    const pass = failures.length === 0 && status === "COMPLETED";
    if (!pass && status === "COMPLETED" && failures.length === 0) {
      failures.push("non-completed result cannot pass validation");
    }

    if (pass) {
      for (const art of checkedArtifacts) {
        const artifactId = newId("ART");
        store.put(
          "artifact",
          artifactId,
          {
            artifact_id: artifactId,
            execution_id: executionId,
            governed_task_id: governed.governed_task_id,
            mission_id: execution.mission_id,
            task_id: execution.task_id,
            path: art.path,
            sha256: art.sha256,
            byte_size: art.byte_size,
            created_at: utcnow(),
            version: 0,
          },
          0,
        );
        store.event({
          entity_type: "artifact",
          entity_id: artifactId,
          event_type: "ARTIFACT_ACCEPTED",
          new_state: String(art.path),
          actor: "PAIR_ARTIFACT_VALIDATOR",
          correlation_id: String(execution.correlation_id),
        });
      }
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
