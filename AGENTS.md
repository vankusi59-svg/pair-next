# AGENTS.md — PAIR Next

Mandatory repository policy for every agent (Devin, Codex, or human
tooling) making code/config changes in this repository.

## PAIR Next — Development Completion Contract

For every code/config change:

1. Before editing, record the integration **BASE SHA** used for the
   change.
2. Create/update `.pair-verification/patch-claim.json`. The claim must
   describe the CURRENT change and must itself be part of the current
   `BASE..HEAD` diff.
3. Implement the requested change.
4. Before reporting the task complete, run:

   ```
   npm run verify:change -- --base <BASE_SHA>
   ```

5. If verification returns `NOT_READY` the agent MUST:
   - inspect the failure;
   - fix the implementation or verification proof;
   - rerun the command;
   - repeat until it returns `READY_FOR_INDEPENDENT_AUDIT`.
6. The agent MUST NOT report implementation completion while
   verification is `NOT_READY`.

The final implementation report must include:

- BASE SHA;
- HEAD SHA;
- changed scope;
- patch claim;
- SELF_AUDIT_FINDINGS;
- SELF_AUDIT_FIXES;
- REGRESSION_TEST_EVIDENCE;
- REMAINING_RISKS;
- SELF_AUDIT_VERDICT;
- VERIFICATION_HARNESS_VERDICT;
- focused/self-test result where relevant;
- tsc result;
- build result;
- full-suite result when run;
- known baselines;
- PR link.

The agent MUST NOT merge its own PR unless the operator explicitly
instructs it to merge after independent audit.

For HIGH-risk changes:

- Harness full-suite policy remains authoritative;
- independent audit remains required before merge.

The Verification Harness is development tooling only. Its result MUST
NOT alter production PAIR authority/runtime behavior.

## Failure Contract

A task is **NOT** complete merely because:

- implementation code is written;
- focused tests pass;
- tsc passes;
- build passes;
- the agent believes the implementation is correct.

For repository code/config changes,
`READY_FOR_INDEPENDENT_AUDIT` from the current-diff-bound Verification
Harness is the minimum completion evidence.

## Current-Claim Rule

An old/stale `patch-claim.json` must never be reused. Every new
development change must modify the current patch claim so that
`.pair-verification/patch-claim.json ∈ BASE..HEAD`, and
`required_tests` must contain executable proof for the current change.

## Self-Audit & Auto-Repair Contract

After implementation — and before running the Verification Harness —
the agent MUST self-audit the entire `BASE..HEAD` diff across these
categories:

- `LOGIC_INVARIANTS` — logic and business invariants;
- `AUTH_SECURITY` — authorization, identity, provenance, security;
- `STATE_LIFECYCLE` — state transitions and lifecycle;
- `IDEMPOTENCY_REPLAY` — idempotency, replay, crash recovery;
- `CONCURRENCY_CAS` — concurrency, CAS, transaction atomicity;
- `EDGE_COMPAT` — edge cases, malformed input, compatibility,
  regression;
- `UI_API` — UI/API consistency where the change touches either.

Only categories relevant to the change require a judgment, but every
category skipped must carry an explicit reason. The agent MUST NOT
conclude the code is safe merely because tests pass.

### Repair loop

When self-audit finds a defect, the agent MUST:

1. record the defect — description, severity, reproduction;
2. write a regression test proving the defect exists before the fix;
3. fix minimally — never expand scope on its own;
4. rerun the related tests;
5. re-audit the areas affected by the fix;
6. run the Verification Harness once repairs complete.

At most **3 repair rounds** are allowed within one handoff. If a
critical defect cannot be resolved, the agent MUST report
`BLOCKED`/`NOT_READY` with evidence — it MUST NOT declare success over
an unresolved critical issue.

### Audit evidence

Every change carries structured audit evidence at
`.pair-verification/self-audit.json`, bound to the current
`BASE..HEAD` diff exactly like the patch claim (stale or missing
evidence is rejected). The harness validates only its structure and
freshness — a report the agent wrote itself is self-attestation, not
independent proof of correctness.

The audit report must distinguish defects the agent found itself from
defects others pointed out, and the agent MUST NOT record verdict
`PASS` while any `P0`/`P1` finding remains unresolved.
