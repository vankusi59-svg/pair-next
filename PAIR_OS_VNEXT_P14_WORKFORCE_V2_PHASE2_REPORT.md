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
