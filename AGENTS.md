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
- verification verdict;
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
