# PAIR NEXT — INCIDENT ACR-1 REMEDIATION REPORT
## Capability-Reject Durable Evidence at the `/api/outbox` Seam

Branch: `devin/1791064626-acr1-capability-reject-evidence`
Base: `main` @ `9ff09ae` (post-F5 R2 merge)
PR: pending audit — DO NOT MERGE.

## 1. Incident provenance

Live mission `MSN_01M4151G6AATT316FFHHASBN2T` FAILED after its DEVIN worker
reported `CAPABILITY_INVALID:signature` on every upload attempt. Cryptographic
re-prove showed the issued capability was VALID:

- HMAC-SHA256 recomputed over the prompt-embedded token vs the production
  broker master → byte-identical signature.
- The exact request replayed via `localhost:8788` and via the Cloudflare
  tunnel → signature stage PASSED; the request failed later at
  `EXECUTION_CLOSED` because the execution had already settled FAILED —
  correct fail-closed behaviour.

Conclusion: the bytes the remote worker sent differed from the issued
capability — but nothing durable recorded what it actually sent, so the
claim could not be disproved from evidence. ACR-1 closes that observability
gap: every capability reject at the verification seam now leaves bounded,
append-only, secret-free evidence.

Brief: `PAIR_NEXT_INCIDENT_CAPABILITY_REJECT_OBSERVABILITY_BRIEF.md`.

## 2. Change

One seam, one private method, ~58 LOC in `src/pair/mission-control.ts`:

- `acceptArtifactUpload` already throws `PolicyError` at four reject
  stages: `signature` (claims null — regex/HMAC failure), `durable_identity`
  (execution/governed lookup or identity mismatch), `mission_id`,
  `task_id` (body≠claims). A `recordArtifactCapabilityReject(stage, token,
  body, claims)` call was added immediately before each throw. No other
  logic changed — the rejects still throw the same `PolicyError` with the
  same stage codes.

- `recordArtifactCapabilityReject`:
  - computes `capability_sha256 = sha256Hex(capabilityToken)` — a digest
    of the RECEIVED value, never the value itself;
  - derives a deterministic entity id `ACR_<sha256[:16]>` and writes at
    most ONE append-only `ARTIFACT_CAPABILITY_REJECTED` event per distinct
    received capability value (dedupe via `store.listEvents` on the
    deterministic id before insert);
  - persists only bounded non-secret fields: `stage`, `capability_sha256`,
    `filename` (≤256), `claimed_mission_id` / `claimed_task_id` /
    `claimed_execution_id` (≤128 each, from verified claims when present,
    else the request body);
  - `new_state` = stage; `actor` = `PAIR_ARTIFACT_INGEST`;
  - the entire write is wrapped so an evidence failure can never mask or
    alter the rejection itself — authorization semantics are byte-for-byte
    unchanged.

Never persisted: raw capability/token, Authorization header, request body
bytes, broker master secret, upload bytes.

## 3. Bounded replay semantics

| Input | Result |
|---|---|
| First corrupted capability value C | 1 `ARTIFACT_CAPABILITY_REJECTED` event under `ACR_<sha256(C)[:16]>` |
| Same C replayed N times | still exactly 1 event (idempotent dedupe) |
| Different corrupted value C′ | 1 additional event under its own deterministic id |
| Valid capability | 0 reject events (none ever minted) |

Each event lands in the append-only events table and is covered by the
existing `event_hash` integrity check (`listEvents` re-verifies
`digest(body) === event_hash` → `FAIL_CLOSED_EVENT_HASH_MISMATCH`).

## 4. Tests — `src/__tests__/pair-acr1-capability-reject-evidence.test.ts` (6)

- **A1** corrupted signature → `PolicyError` `CAPABILITY_INVALID` + exactly
  one durable reject event; `capability_sha256` equals the digest of the
  RECEIVED (corrupted) value, not the issued capability.
- **A2** same corrupted value replayed ×3 → exactly one event; a second
  distinct corruption → exactly two events total.
- **A3** `durable_identity` reject (claims valid against issued cap, but
  execution already terminal) → `CAPABILITY_MISMATCH`, event records the
  verified claim identities.
- **A4** valid capability → accepted, zero reject events.
- **A5** secret hygiene — dumps the whole persisted corpus (events +
  payload + metadata) and asserts the raw capability value, master
  secret, and body bytes never appear.
- **A6** mutating a persisted reject event's metadata trips
  `FAIL_CLOSED_EVENT_HASH_MISMATCH` on read (append-only integrity).

## 5. Validation

| Gate | Result |
|---|---|
| ACR-1 focused | 6/6 PASS |
| F1 artifact authority + R1 + R2 | 197/197 PASS |
| F2 chain + F4 + output-delivery | 279/279 PASS |
| F5 remote-producer closure | (inside focused run) PASS |
| `npx tsc --noEmit` | 0 errors |
| `rm -rf dist && pnpm build` | PASS |
| Full suite | 3304 pass / **2 fail** — the two known env-only P5 failures (DSH/CODEX executables present on this box flip "not available" probe asserts); unchanged, unrelated |
| `pnpm audit --audit-level=high` | 0 high |

## 6. Explicit non-changes

- Authorization semantics unchanged: same `PolicyError`, same stage
  codes, same order — a rejected capability is rejected exactly as before.
- No architecture broadening: reuses `store.event`/`listEvents` and the
  existing events-hash integrity; no new tables, no new endpoints.
- No F5 contract change: `declared_produces` pinning, mint anchors, and
  the terminal closure gate are untouched.
- No `issued_at` expiry/recency behaviour — explicitly out of scope.

## 7. Residual technical debt

- A dedupe collision (two distinct capability values sharing the same
  64-bit sha256 prefix) would merge their reject evidence under one
  entity — cryptographically negligible; documented, not hardened.
- Reject evidence exists only for the upload lane (`acap1`); the consume
  lane (`acread1`) has its own reject stages not yet instrumented — same
  pattern applies if a future mandate wants it.

Classification: `PAIR_NEXT_INCIDENT_ACR1_CAPABILITY_REJECT_EVIDENCE_PENDING_AUDIT`
