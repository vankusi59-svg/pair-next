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
import {
  MAX_ARTIFACTS_PER_EXECUTION,
  artifactNamesEquivalent,
} from "./artifact-authority.js";
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
    // F5.3 + R1/R2 — REMOTE declared-produces closure under the
    // immutable mint-time authority chain:
    //   executor_execution → governed_task → exactly-one
    //   GOVERNED_TASK_VALIDATED anchor → anchor.remote_produces_contract.
    // R2.A: F5 applicability NEVER derives from the current (mutable)
    // task row — a post-dispatch capability rewrite or task deletion can
    // no longer downgrade an F5-minted execution. R2.B: the anchor's
    // complete pinned identity (governed/mission/task/executor/plan)
    // must correspond across anchor ↔ governed ↔ execution. R2.C: an
    // anchor marked remote_produces_contract must SELF-VALIDATE — its
    // declared_produces must be a normalized sorted-deduped bounded
    // array whose digest equals declared_produces_digest; the CURRENT
    // declared set is then required to digest-equal that immutable mint
    // set, and the recomputed scope must equal the anchor's immutable
    // approval_scope_digest. Only then does canonical artifact closure
    // run. A pre-F5 anchor (marker field absent) preserves documented
    // legacy semantics — immutable provenance decides legacy, never
    // field absence on a mutable row.
    const declaredRaw = (
      governed.expected_output_contract as Record<string, unknown> | undefined
    )?.declared_produces;
    let remoteProducesMissing: string[] = [];
    let declaredProducesDigest: string | null = null;
    if (pass) {
      const gtid = String(governed.governed_task_id);
      const anchors = store
        .listEvents("governed_task", gtid)
        .filter(
          (ev) => String(ev.event_type) === "GOVERNED_TASK_VALIDATED",
        );
      if (anchors.length !== 1) {
        failures.push(
          `FAIL_CLOSED_GOVERNED_MINT_ANCHOR:${
            anchors.length === 0 ? "MISSING" : "AMBIGUOUS"
          }`,
        );
        pass = false;
      } else {
        const meta = (anchors[0].metadata ?? {}) as Record<
          string,
          unknown
        >;
        const strEq = (a: unknown, b: unknown): boolean =>
          typeof a === "string" && a.length > 0 && a === b;
        const marker = meta.remote_produces_contract;
        // R2.B — the complete mint identity, three-way. F5-era anchors
        // (the marker field present) must bind EVERY pinned identity
        // field — governed/mission/task/executor/plan across anchor ↔
        // governed ↔ execution. Pre-F5 anchors carry only the original
        // three identity fields and keep the documented legacy check.
        const legacyIdentityOk =
          strEq(meta.mission_id, governed.mission_id) &&
          strEq(meta.mission_id, execution.mission_id) &&
          strEq(meta.task_id, governed.task_id) &&
          strEq(meta.task_id, execution.task_id) &&
          strEq(meta.executor_id, governed.executor_id) &&
          strEq(meta.executor_id, execution.executor_id);
        const identityOk =
          marker === undefined
            ? legacyIdentityOk
            : legacyIdentityOk &&
              strEq(meta.governed_task_id, gtid) &&
              strEq(meta.governed_task_id, execution.governed_task_id) &&
              strEq(meta.plan_id, governed.plan_id) &&
              Number.isFinite(Number(meta.plan_revision)) &&
              Number(meta.plan_revision) ===
                Number(governed.plan_revision) &&
              Number(meta.plan_revision) ===
                Number(execution.plan_revision);
        if (!identityOk) {
          failures.push("FAIL_CLOSED_GOVERNED_MINT_ANCHOR:IDENTITY");
          pass = false;
        } else {
          if (marker === true) {
            // R2.C — anchor self-validation: the immutable declared set
            // must itself satisfy the mint normalization contract
            // (string names, already-trimmed, unique, canonically
            // sorted, inside the per-execution bound) and digest-match
            // its own declared_produces_digest.
            const ad = meta.declared_produces;
            const adDigest = meta.declared_produces_digest;
            const anchorDeclaredOk =
              Array.isArray(ad) &&
              ad.every(
                (n) =>
                  typeof n === "string" &&
                  n.length > 0 &&
                  n === n.trim(),
              ) &&
              new Set(ad as unknown[]).size ===
                (ad as unknown[]).length &&
              [...(ad as string[])].sort().join("") ===
                (ad as string[]).join("") &&
              (ad as string[]).length <= MAX_ARTIFACTS_PER_EXECUTION &&
              typeof adDigest === "string" &&
              adDigest.length > 0 &&
              digest(ad) === adDigest;
            const mintScopeDigest = String(
              meta.approval_scope_digest ?? "",
            );
            const currentScope = {
              mission_id: governed.mission_id,
              task_id: governed.task_id,
              executor_id: governed.executor_id,
              workspace: String(governed.workspace),
              allowed_paths: governed.allowed_paths,
              permissions: governed.permissions ?? [],
              expected_output_contract: governed.expected_output_contract,
              dependency_artifacts_digest:
                governed.dependency_artifacts_digest,
            };
            if (!anchorDeclaredOk) {
              failures.push(
                "FAIL_CLOSED_GOVERNED_MINT_ANCHOR:DECLARED_PRODUCES",
              );
              pass = false;
            } else if (!Array.isArray(declaredRaw)) {
              failures.push(
                "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces",
              );
              pass = false;
            } else if (
              !mintScopeDigest ||
              digest(currentScope) !== mintScopeDigest
            ) {
              failures.push(
                "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
              );
              pass = false;
            } else if (digest(declaredRaw) !== adDigest) {
              failures.push(
                "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces_digest",
              );
              pass = false;
            } else {
              declaredProducesDigest = adDigest as string;
              const declared = declaredRaw
                .map((n) => String(n))
                .filter((n) => n.length > 0);
              if (declared.length) {
                const verified = new Set(acceptedIds);
                const acceptedRows = service.artifacts
                  .forExecution(executionId)
                  .filter((a) => verified.has(String(a.artifact_id)));
                // RPN-1 — declared names compare through the ONE
                // canonical DSN-1 equivalence rule (outbox/<basename>
                // staging alias), never raw strings. RPN-1 R1 — the
                // closure is an INJECTIVE binding: one declared slot ↔
                // one unique accepted artifact identity, so a single
                // produced artifact can never close two separately
                // pinned declarations. Phase 1 binds every exact-name
                // declaration first; phase 2 closes remaining
                // declarations through the equivalence band against
                // still-UNBOUND artifacts only. Name match alone never
                // authorizes — every candidate is already an ACCEPTED
                // artifact CAS-verified for THIS execution.
                const boundArtifactIds = new Set<string>();
                const unresolved: string[] = [];
                for (const name of declared) {
                  const exact = acceptedRows.filter(
                    (a) =>
                      String(a.logical_name) === name &&
                      !boundArtifactIds.has(String(a.artifact_id)),
                  );
                  if (exact.length === 1) {
                    boundArtifactIds.add(String(exact[0]!.artifact_id));
                  } else {
                    unresolved.push(name);
                  }
                }
                for (const name of unresolved) {
                  const candidates = acceptedRows.filter(
                    (a) =>
                      !boundArtifactIds.has(String(a.artifact_id)) &&
                      artifactNamesEquivalent(name, a.logical_name),
                  );
                  if (candidates.length === 1) {
                    boundArtifactIds.add(String(candidates[0]!.artifact_id));
                  } else {
                    remoteProducesMissing.push(name);
                  }
                }
              }
              if (remoteProducesMissing.length) {
                for (const name of remoteProducesMissing) {
                  failures.push(
                    `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:${name}`,
                  );
                }
                pass = false;
              }
            }
          } else if (marker !== undefined && marker !== false) {
            failures.push("FAIL_CLOSED_GOVERNED_MINT_ANCHOR:MARKER");
            pass = false;
          }
          // marker === false → non-F5 contract; marker absent → the
          // anchor predates F5 and keeps documented legacy semantics.
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
