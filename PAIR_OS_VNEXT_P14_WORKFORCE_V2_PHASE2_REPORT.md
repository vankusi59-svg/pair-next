# PAIR OS vNext — P14 Workforce V2 Phase 2 Report

Canonical claim lease + heartbeat/fencing + durable inbox on top of the merged
Phase 1 rebaseline (`41934b2`). Coordination only — no Phase 2 code path creates
missions, satisfies dependencies, or bypasses the canonical
`openWorkItem → work_open_binding → Planner → MissionRouter → GovernedTaskGate`
authority chain.

- Branch: `devin/1790749503-p14-wfv2-p2`
- Base: `41934b206bccbf8eb760666ca623760d1c4ef3fb` (PR #12 merge commit)
- Classification: `P14_WORKFORCE_V2_PHASE2_PENDING_INDEPENDENT_AUDIT`

## 1. Claim lease architecture (§2-§7)

`work_claim_lease` — one row per work item, deterministic id `WCL_<work_item_id>`:

| Field | Semantics |
|---|---|
| `lease_epoch` | int ≥ 1; +1 on every reclaim — stale tokens fence at the epoch boundary |
| `token_digest` | `digest("work-claim-token:"+token)`; raw token never persisted |
| `issued_at` / `last_heartbeat_at` / `expires_at` | invariant: `issued ≤ hb`, `exp > issued` |
| `state` | ACTIVE \| RELEASED \| EXPIRED \| REVOKED |
| `lease_digest` | recompute-checked over 11 canonical fields |

`assertCanonicalClaimLease` (§14) is the single validator consumed at every seam:
deterministic id, state enum, item exists, business/project match, claimant
exists + same business, ACTIVE ⇒ claimant == canonical assignee, epoch/range
checks, digest recompute, ACTIVE+mirror disagreement → corrupt.

Claim (`claimWorkItem`) is one `store.immediate()` txn: pending-open resolve →
quarantine → `assertGraphAuthority` → eligibility order (agent exists → same
business → ACTIVE → assignee UNASSIGNED/ASSIGNEE_MISMATCH → `assertExecutable`)
→ lease CAS. Live ACTIVE foreign lease → `FAIL_CLOSED_WORK_ITEM_CLAIMED`; same
agent → `FAIL_CLOSED_WORK_ITEM_CLAIM_ALREADY_HELD` (never rotate/reveal);
expired/RELEASED → fence then mint epoch+1 token. Mirrors
(`claimed_by`/`claim_expires_at`/`claim_token`) are observability-only writes.

Heartbeat (`heartbeatWorkItem`): canonical lease → ACTIVE → claimant exact →
token digest exact → expiry check (fences EXPIRED inside the txn, throws after
commit so the fence persists) → `assertExecutable` → renew TTL bounded by
`PAIR_WORK_ITEM_CLAIM_MS` (default 30 min; no caller TTL, no rotation) → mirror
update + `WORK_CLAIM_HEARTBEAT`.

Release (`releaseClaim`): live ACTIVE lease requires matching token digest →
RELEASED + mirror clear + `WORK_CLAIM_RELEASED`; already-terminal is an
idempotent no-op. `cancelWorkItem`/`syncWorkItem` fence ACTIVE leases to
REVOKED/RELEASED inside the same txn as the status change.

## 2. openWorkItem + legacy claims (§8-§9)

`openWorkItem` no longer mints `claim_token`; the gate is
`assertNoForeignLiveLease(row, agentId)` — corrupt lease → PROVENANCE_CORRUPT;
live foreign → `FAIL_CLOSED_WORK_ITEM_CLAIMED`; expired → fenced EXPIRED then
proceed; phantom mirrors (no live lease) are cleared inside the txn with an
optional `WORK_CLAIM_MIRRORS_CLEARED` event — never adopted as authority, never
fabricate a WCL, never cancel a bound mission. The helper ends by re-syncing the
caller's row (`Object.assign`) after its own txn bumps `version`. The same gate
runs in `assignWorkItem`.

## 3. Durable inbox (§10-§13)

- `workforce_message` (`WFM_<id>`): append-only, state COMMITTED, kinds
  NOTE/REQUEST/STATUS/BLOCKER_NOTICE/HANDOFF_REQUEST, `message_digest` over the
  canonical field set.
- `workforce_message_receipt` (`WIR_<msg>_<recipient>`): PENDING → ACKNOWLEDGED,
  `acknowledged_at` pinned at first ack; duplicate ack returns the same row —
  exactly one `WORKFORCE_MESSAGE_ACKNOWLEDGED` event.
- `sendWorkforceMessage`: business exists, kind enum, non-empty body, recipient
  exists + same business (`FAIL_CLOSED_MESSAGE_SCOPE`), optional `work_item_id`
  must be same-business + not quarantined + `assertGraphAuthority`, AGENT sender
  same-business + ACTIVE (`FAIL_CLOSED_AGENT_INACTIVE`), OPERATOR requires
  `sender_operator_id`. Message + receipt + `WORKFORCE_MESSAGE_SENT` commit in
  one txn.
- HANDOFF_REQUEST mutates nothing — assignee, status, WGM, delegation,
  open_binding all provably unchanged.

## 4. Restart reconciliation (§15)

`reconcileWorkGraph` extended with four sweeps: every WCL run through
`assertCanonicalClaimLease` (corrupt → quarantine the item, continue);
live-ACTIVE lease whose claimant/mirrors disagree → repaired; naturally-expired
ACTIVE leases fenced EXPIRED with `WORK_CLAIM_EXPIRED` evidence
(`actor: PAIR_WORKFORCE_RECONCILE`); phantom mirrors cleared; every
`workforce_message`/`workforce_message_receipt` validated — corrupt rows emit
`WORK_COORDINATION_CORRUPT` evidence. Never fabricates rows, never terminates
missions, fully idempotent (an already-quarantined item is not re-reported but
stays `TERMINAL_PROVENANCE_CORRUPT`).

## 5. API surface (§13)

- `POST /api/work-items/:id/claim` `{agent_id}` → work item + `claim_token`
  (the ONLY payload that ever carries a raw token)
- `POST /api/work-items/:id/heartbeat` `{agent_id, claim_token}` → safe lease view
- `POST /api/work-items/:id/release` `{agent_id, claim_token?}` → work item
- `GET  /api/work-items/:id/claim` → `safeLeaseView` (no token fields)
- `POST/GET /api/work-items/:id/messages`
- `GET  /api/org-agents/:id/inbox` (adds `receipt_status`)
- `POST /api/workforce/messages/:id/ack` `{agent_id}`

`stripClaimToken` recursively removes `claim_token` from every non-claim
response, including GET work-items.

## 6. Test results

| Suite | Result |
|---|---|
| `pair-p14-wfv2-p2.test.ts` | **40/40** |
| `pair-p14-workforce-v2.test.ts` (Phase 1 incl. R1+R2) | 73/73 |
| P14 Foundation V2 | 35/35 |
| Runtime hardening | 11/11 |
| P13 / P12 / P11+r / P10 / P9 / P6 | 67+71+103+31+79+36 all green |
| Node 22 full suite | 2082 pass, 2 fail — pre-existing P5 env gaps (executor probes unavailable on this box; identical to PR #12 evidence) |
| Node 20 full suite | 2084 pass, 0 fail |
| `tsc --noEmit` | clean |
| `pnpm build` | PASS |
| `pnpm audit --audit-level=high` | 0 high (9 moderate/low, unchanged baseline) |
| `verifyIntegrity` | exercised by P10 suite — clean |

Concurrency evidence: `P14-P2-CLAIM-CONCURRENT-SINGLE-WINNER` races two store
connections on the same item — exactly one `WORK_CLAIM_ACQUIRED` winner, the
loser fails closed, exactly one lease row. P11-R1/R2 multi-connection CAS suites
re-run green.

## 7. Fresh-server E2E (§18) — `PAIR_MC_DIR=/tmp/pair-mc-p2`, `PAIR_WORK_ITEM_CLAIM_MS=2500`, port 8791

- **A** claim → raw token only in the claim response (asserted absent from GET
  claim, work-items list, inbox) → heartbeat 200 → wrong token `FAIL_CLOSED_CLAIM_TOKEN`
  → TTL expiry → heartbeat `FAIL_CLOSED_WORK_CLAIM_EXPIRED` + lease EXPIRED →
  stale-token release on expired lease idempotent → reclaim mints **epoch 2** +
  fresh token → old token `FAIL_CLOSED_CLAIM_TOKEN` → new heartbeat ACTIVE →
  release 200 → RELEASED.
- **B** unclaimed item open → IN_PROGRESS, `claim_token: null`, bound mission —
  fast path mints nothing.
- **C** claim on IN_PROGRESS item, expiry fencing → lease EXPIRED while mission
  `MSN_…C8M2` ran the canonical path to COMPLETED (PAIR_NATIVE execution record
  + `mission_goal.txt` artifact) — no cancel, no redispatch, no duplicate
  mission; stale token dead.
- **D** AGENT→AGENT REQUEST → inbox PENDING → wrong-recipient ack
  `FAIL_CLOSED_MESSAGE_RECIPIENT_MISMATCH` → ack ACKNOWLEDGED → dup ack
  idempotent → HANDOFF_REQUEST sent with assignee/status/graph untouched.
- **E** restart on the same DB: RELEASED epoch-2 and EXPIRED epoch-1 leases
  preserved; stale token still fenced; inbox preserved (REQUEST ACKNOWLEDGED,
  HANDOFF PENDING); dup ack still idempotent; no duplicate messages/missions;
  startup reconcile left canonical state untouched.

## 8. Scope discipline (§20)

No autonomous reassignment, no graph revisioning, no scheduler/load balancer,
no completion cascade, no mission inference from heartbeat, no second
planner/router/dispatcher/runtime. `worker-protocol.ts`/LocalWorkerPool/
`PAIR_WORKER_FILE` untouched — executor protocol, not workforce coordination.
WGM/WDEL/WDEC/WDS/WGE/WAB/ACR/WORK_AUTHORITY_BOUND, Foundation V2 binding,
openWorkItem, Planner, MissionRouter, GovernedTaskGate, MissionRuntime,
P12/P13 all preserved (regression counts above).

# REMEDIATION R1 — ATOMIC CLAIM ADMISSION + IMMUTABLE COLLABORATION PROVENANCE

Head: `see PR` (R1 commits on `devin/1790749503-p14-wfv2-p2`, base `41934b2`)

## R1.1 Transactional claim design (§1)

`claimWorkItem` now runs its decisive admission proof **inside** the
`store.immediate()` that writes the WCL:

1. preflight stays (fast errors: row exists, business, ACTIVE, assignee,
   `assertExecutable`);
2. `store.immediate(() => …)` re-reads `cur0 = store.get("work_item")` and
   re-proves — on current rows — quarantine, `assertGraphAuthority`, terminal
   state, business match, `curAgent` ACTIVE, `curAssignee` UNASSIGNED /
   ASSIGNEE_MISMATCH, and `agentContracts.assertExecutable(curAgent)`;
3. only then does the lease CAS/mint occur in the same transaction.

Any interleaved mutation (assign, pause/terminate, contract disable, project
revocation) lands before BEGIN IMMEDIATE acquires → the in-txn re-read sees it
and the claim fails closed; or after commit → the lease is canonically
consistent. TOCTOU closed by construction.

## R1.2 Assign + lease gate atomic (§2)

`assignWorkItem` wraps work-item re-read, quarantine, `assertGraphAuthority`,
graph assignee-immutability, agent scope/ACTIVE, transition legality, the
`leaseGateInTxn` foreign-live-lease gate, and the assignee CAS in ONE
`immediate()`. `leaseGateInTxn` reads the WCL fresh inside the txn, validates,
fences expiry, and rejects a live foreign claimant with
`FAIL_CLOSED_WORK_ITEM_CLAIMED` — the stale-snapshot gap where the old code
read the lease before entering its write txn is removed. The invariant
`work_item.assignee = B ∧ ACTIVE WCL.claimant = A (A≠B)` is unreachable: the
two decisive checks are serialized by BEGIN IMMEDIATE.

`assertNoForeignLiveLease` (open/seam callers) now delegates the read+validate
into the same `leaseGateInTxn` inside its own `immediate()`; mirror repair
rides the same work-item write and the caller's stale row is re-synced
(`Object.assign(row, store.get(...))`) so outer code never writes a rolled-back
image.

## R1.3 Lifecycle interleave (§3)

A claim commits only if the agent/contract/project are executable *at commit
time* (re-checked in-txn). Post-claim PAUSED/TERMINATED/DISABLED stays
historical — heartbeat/open apply current admission rules at their own seams;
no retro-invalidation of a validly minted lease.

## R1.4 Lease time ordering (§4)

`assertCanonicalClaimLease` now requires parseable canonical timestamps AND
`issued_at <= last_heartbeat_at < expires_at` (strict). `hb >= exp`, malformed,
or future-inconsistent windows → `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`.

## R1.5 Message immutable anchor (§5)

`WORKFORCE_MESSAGE_SENT` (append-only hash-chained event) pins at commit:
`message_id, business_id, work_item_id, sender_type, sender_agent_id,
sender_operator_id, recipient_agent_id, kind, correlation_id, message_digest,
receipt_id, receipt_created_at` — never the body.
`assertCanonicalWorkforceMessage` requires exactly one matching SENT event and
compares every pinned field; tampering the row + recomputing
`message_digest` fails because the event still holds the original digest.

## R1.6 Receipt / ACK provenance (§6)

`assertCanonicalReceipt`: deterministic `WIR_<mid>_<recipient>` id + exact
message/recipient + creation provenance via the message's SENT event
(`receipt_id`, `receipt_created_at` pinned). ACKNOWLEDGED additionally requires
exactly one `WORKFORCE_MESSAGE_ACKNOWLEDGED` event pinning
`message_id + recipient_agent_id + acknowledged_at` (the event's timestamp is
the one stored). Direct PENDING→ACKNOWLEDGED row mutation without the event →
PROVENANCE_CORRUPT; a matching ACK event on a PENDING row → same. Duplicate
ack stays idempotent (returns existing row, no second event).

## R1.7 Read seams (§7)

`listWorkItemMessages` validates each message before returning — corrupt rows
are surfaced as explicit `{state:"CORRUPT", corrupt:true}` projections (no
body). `inboxForAgent` validates message + receipt — corrupt receipt surfaces
`receipt_status:"CORRUPT"`. `getWorkItemClaim` validates the WCL before
returning the safe view. Forged content is never presented as valid.

## R1.8 Reconcile idempotency (§8)

The message/receipt sweeps in `reconcileWorkGraph` check
`listEvents(entity)` for an existing `WORK_COORDINATION_CORRUPT` before
appending — repeated reconciles on a permanently corrupt row append exactly
one event. Work-item quarantine already deduped by `blocked_code`. Immutable
bodies are never "repaired" in place; ACKs are never fabricated.

## R1.9 Focused tests (§9)

+10 tests (40 → **50**):

- `P14-P2-R1-CLAIM-ASSIGN-RACE`, `…-ASSIGN-CLAIM-RACE-INVERSE`,
  `…-CLAIM-PAUSE-RACE`, `…-CLAIM-CONTRACT-DISABLE-RACE` — **genuine
  worker_threads races**: two processes on the same db file released on a
  shared Atomics barrier; winner/loser asserted on `FAIL_CLOSED_*` /
  `SQLITE_BUSY` and the final invariant verified from a fresh connection.
- `P14-P2-R1-LEASE-TIME-ORDER` — hb==exp and unparseable timestamp both
  PROVENANCE_CORRUPT (with valid digest).
- `P14-P2-R1-MESSAGE-TAMPER-REHASH` — body forge + recomputed digest fails
  at the event anchor.
- `P14-P2-R1-RECEIPT-FORGED-ACK` — direct row ACK without event fails.
- `P14-P2-R1-ACK-EVENT-IDEMPOTENT` — one ACK event across duplicate acks.
- `P14-P2-R1-CORRUPT-MESSAGE-READ-FAILS` + `CORRUPT-RECEIPT-READ-FAILS` —
  read seams emit CORRUPT markers, never forged content.
- `P14-P2-R1-CORRUPT-RECONCILE-IDEMPOTENT` — 2 corrupt rows → exactly 2
  corruption events across 3 reconciles.

## R1.10 Preserved boundaries (§10)

Coordination ≠ execution; heartbeat ≠ executor liveness; no auto
redispatch/reassign; HANDOFF is data-only; no graph revisioning; no Phase-3
cascade; unclaimed open fast path unchanged; raw token returned once at claim,
never persisted.

## §R2 — Collaboration Provenance Completeness (R2 remediation)

### R2.1 Missing receipt fails closed (§1)
Every committed `workforce_message` has a canonical receipt identity pinned by its
immutable `WORKFORCE_MESSAGE_SENT` event (`receipt_id`, `receipt_created_at`). The
prior defect — `inboxForAgent` defaulting `receipt_status = "PENDING"` when the
receipt row was absent — fabricated valid-looking state from missing evidence.
Removed. For every canonical message, `expected_receipt_id = WIR_<mid>_<recip>`
must exist and pass `assertCanonicalReceipt`; missing/corrupt → `CORRUPT`, fail
closed. The missing receipt is never recreated.

### R2.2 Collaboration-bundle validation at all read seams (§2)
New helper `assertCanonicalCollaborationBundle(deps, msg)` in `work-coordination.ts`:
validates the message, derives the expected receipt id, requires the exact row,
validates it, and returns the receipt Row. Non-recursive — the bundle calls both
validators once (the receipt validator already consumes the message validator in
one direction). `listWorkItemMessages()` and `inboxForAgent()` now surface only the
explicit `CORRUPT` projection (`corrupt: true`, no body, `receipt_status: CORRUPT`)
for any bundle failure — forged content is never returned as valid data, PENDING is
never synthesized. `getWorkItemClaim()` unchanged.

### R2.3 Reconcile detects missing receipts (§3)
`reconcileWorkGraph()` sweeps `workforce_message` rows through
`assertCanonicalCollaborationBundle` — a deleted/corrupt receipt is now detected by
its derived expected identity. Deterministic `WORK_COORDINATION_CORRUPT` evidence
pins the **message entity** (`entity_id = WFM_<mid>`) and is appended at most once
per row (existing `alreadyFlagged` dedupe), so repeated reconcile/restart passes
emit no duplicates and never fabricate the receipt.

### R2.4 ACK event pins all required fields (§4)
`assertCanonicalReceipt` now requires the canonical `WORKFORCE_MESSAGE_ACKNOWLEDGED`
event metadata to match **all** of `message_id`, `recipient_agent_id`, and
`acknowledged_at` — a forged/malformed ACK event with the wrong `message_id` pin
fails closed even when `entity_id`, recipient, and timestamp otherwise match.
Exactly one matching ACK event is still required for `ACKNOWLEDGED`; duplicate
legitimate ACK remains idempotent with one event.

### R2.5 Race evidence correction (§5)
`P14-P2-R1-ASSIGN-CLAIM-RACE-INVERSE` rewritten as a genuine two-worker
`worker_threads` race on the existing Atomics barrier — `assign(B)` vs in-txn
`heartbeat(A, claim_token)`: assign loses deterministically
(`FAIL_CLOSED_WORK_ITEM_CLAIMED`), heartbeat wins; `assignee=B ∧ ACTIVE WCL(A)`
asserted unreachable (`assertNoClaimAssignSplit`). No report/test claims a race
that wasn't executed. Added `P14-P2-R1-CLAIM-PROJECT-REVOKE-RACE`: `claim(A)` vs
contract `allowed_project_ids` revocation — the in-transaction
`assertExecutable()` project-scope closure is exercised genuinely; winner
whichever commits first, loser fails closed, lease/CLAIM_ACQUIRED consistent.

### R2.6 Validation
- Focused P2: **55/55** (50 R1 + 5 R2, incl. genuine races)
- Regression: Phase1 73 · P14F 35 · RH 11 · P13 67 · P12 71 · P11+r 103 · P10 31 ·
  P9 79 · P6 36 · N22: 2097 + 2 fail (P5 env-gap, pre-existing) · N20: 2099/0 ·
  tsc clean · build PASS · `pnpm audit --audit-level=high` clean
- Fresh-server E2E: operator→business→agent→work-item→message over the real API;
  receipt deleted via direct sqlite → `inbox`/`list` return `CORRUPT` (no body,
  `corrupt: true`, never `PENDING`); server restart → reconcile appends exactly
  one `WORK_COORDINATION_CORRUPT` on the message entity; receipt never recreated;
  inbox still `CORRUPT` after restart.
