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
import { digest, newId, pathWithin, utcnow } from "./canonical.js";
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

    const status = String(result?.status ?? "FAILED");

    const validationId = newId("XVLD");
    const failures: string[] = [];

    // R6.2 — the validator is an independent terminal defense: it must
    // survive malformed result structure even though Gate normally
    // rejects it first. A non-array `artifacts` fails the validation;
    // each entry must be a non-null, non-array object — never coerced.
    // R7.1 — the validator independently requires `artifacts` to be an
    // array: missing/undefined/null/object/string all FAIL here even
    // though Gate is normally the canonical ingress. An executor with
    // nothing to declare must explicitly emit `artifacts: []`.
    const rawArtifacts: unknown = result?.artifacts;
    if (!Array.isArray(rawArtifacts)) {
      failures.push("result.artifacts is not an array");
    }
    const artifactEntries: unknown[] = Array.isArray(rawArtifacts) ? rawArtifacts : [];

    // Result-state gate: a non-COMPLETED result may never carry validated artifacts.
    const checkedArtifacts: Array<Record<string, unknown>> = [];
    for (const entry of artifactEntries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        failures.push("artifact entry is not an object");
        continue;
      }
      const art = entry as Record<string, unknown>;
      const relField: unknown = art.path;
      const rel = typeof relField === "string" ? relField : "";
      if (typeof relField !== "string" || !rel || path.isAbsolute(rel) || rel.split("/").includes("..")) {
        failures.push(`artifact path invalid: ${rel || "<invalid>"}`);
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
      // R5.1 — the worker-result contract is mandatory: every declared
      // artifact carries its DECLARED sha256 (exactly 64 lowercase hex)
      // and byte_size (finite non-negative integer). Missing metadata is
      // a contract failure — PAIR computes actual bytes itself, but it
      // never computes the worker's declaration for it.
      const declaredSha = art.sha256;
      if (typeof declaredSha !== "string" || !/^[0-9a-f]{64}$/.test(declaredSha)) {
        failures.push(`artifact declaration invalid sha256: ${rel}`);
        continue;
      }
      const declaredSize = art.byte_size;
      if (
        typeof declaredSize !== "number" ||
        !Number.isInteger(declaredSize) ||
        declaredSize < 0
      ) {
        failures.push(`artifact declaration invalid byte_size: ${rel}`);
        continue;
      }
      // R2.2 — the validator performs NO independent content read. The
      // declared sha256/byte_size are forwarded as expectations; the ONE
      // authoritative materialization inside ArtifactAuthority reads the
      // bytes once and compares them, so VALIDATED BYTES == CANONICAL
      // RETAINED BYTES (no validate-then-reread TOCTOU).
      checkedArtifacts.push({
        path: rel,
        sha256: declaredSha,
        byte_size: declaredSize,
      });
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
            expected_sha256: String(art.sha256),
            expected_byte_size: Number(art.byte_size),
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
    // F1 §7 + R5.2 — remote executions return artifacts:[] adapter-
    // side, but capability-bound uploads already minted canonical ART_*
    // rows. A terminal PASS may only expose artifact_ids whose retained
    // CAS bytes verify NOW — the authority re-proves every candidate
    // row (complete identity + storage contract + retained bytes via
    // the R4 open-object primitive); ANY malformed or unverifiable row
    // fails the whole validation rather than being dropped silently.
    if (pass) {
      try {
        const verifiedIds = service.artifacts.verifyForExecution(executionId);
        acceptedIds.push(...verifiedIds.filter((id) => !acceptedIds.includes(id)));
      } catch (e) {
        failures.push(
          `artifact retained-byte verification failed: ${e instanceof IntegrityError ? `${e.code}:${e.message}` : String(e)}`,
        );
        pass = false;
      }
    }
    // F5.3 — REMOTE declared-produces closure: a remote execution whose
    // pinned contract carries `declared_produces` may only reach PASS
    // when EVERY declared logical name resolves to exactly ONE canonical
    // verified artifact identity belonging to THIS execution. Completion
    // prose, remote files, executor claims, filenames or shared-outbox
    // contents grant zero authority — only ARTIFACT_ACCEPTED rows that
    // verify NOW count. The approval-scope re-derivation below also
    // proves the governed contract itself was not mutated post-mint
    // (a rewritten `declared_produces` or `expected_output_contract`
    // changes the scope digest and fails closed).
    const declaredRaw = (
      governed.expected_output_contract as Record<string, unknown> | undefined
    )?.declared_produces;
    let remoteProducesMissing: string[] = [];
    let declaredProducesDigest: string | null = null;
    if (pass && Array.isArray(declaredRaw)) {
      declaredProducesDigest = digest(declaredRaw);
      const scope = {
        mission_id: governed.mission_id,
        task_id: governed.task_id,
        executor_id: governed.executor_id,
        workspace: String(governed.workspace),
        allowed_paths: governed.allowed_paths,
        permissions: governed.permissions ?? [],
        expected_output_contract: governed.expected_output_contract,
        dependency_artifacts_digest: governed.dependency_artifacts_digest,
      };
      if (
        digest(scope) !== String(governed.approval_scope_digest ?? "")
      ) {
        failures.push(
          "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
        );
        pass = false;
      } else {
        const declared = declaredRaw
          .map((n) => String(n))
          .filter((n) => n.length > 0);
        if (declared.length) {
          const verified = new Set(acceptedIds);
          const acceptedRows = service.artifacts
            .forExecution(executionId)
            .filter((a) => verified.has(String(a.artifact_id)));
          for (const name of declared) {
            const identities = acceptedRows.filter(
              (a) => String(a.logical_name) === name,
            ).length;
            if (identities !== 1) remoteProducesMissing.push(name);
          }
          if (remoteProducesMissing.length) {
            for (const name of remoteProducesMissing) {
              failures.push(`FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:${name}`);
            }
            pass = false;
          }
        }
      }
    }
    if (!pass) {
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
        // F5 — bounded typed evidence for the produces gate (no paths,
        // no secrets, no remote prose): the logical names that failed
        // closure and the pinned declared-set digest.
        ...(remoteProducesMissing.length
          ? { remote_produces_missing: remoteProducesMissing }
          : {}),
        ...(declaredProducesDigest
          ? { declared_produces_digest: declaredProducesDigest }
          : {}),
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
      ...(remoteProducesMissing.length
        ? {
            remote_produces_missing: remoteProducesMissing,
            declared_produces_digest: declaredProducesDigest,
            governed_task_id: governed.governed_task_id,
            task_id: governed.task_id,
            mission_id: execution.mission_id,
          }
        : {}),
    });
    return validation;
  }
}
