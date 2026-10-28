# Personal Mode — architecture decision note (Phase A)

Mission: `PAIRNEXT_UI_V2_PERSONAL_MODE_DEVIN_MISSION.md`
BASE: `4d30c7fe453a62f398179d68022ffff66b466070` (latest main incl. PR #159)

## Verified ingress topology (recon)

- `scripts/serve-mission-control.mjs` runs ONE `http.Server` via
  `server.listen(8788)` — binds **all interfaces** (no host arg).
- `scripts/start-pair-live.sh` runs `cloudflared tunnel --url
  http://localhost:8788` → the SAME listener serves the owner's local
  browser AND remote/tunneled traffic.
- Consequence: `remoteAddress===127.0.0.1` cannot distinguish a local
  browser from a cloudflared-forwarded remote request. Host/cf-* header
  heuristics alone are not provable separation (mission §2.2 critical
  limitation).

## Decision: split listeners (provable separation)

When `PAIR_PERSONAL_MODE=local`:

| Listener | Bind | Ingress class | Personal session |
|---|---|---|---|
| `PAIR_MC_PORT` (8788) | `127.0.0.1` only | `local` | mintable + usable |
| `PAIR_MC_REMOTE_PORT` (8790) | all interfaces | `remote` | never |

- Same `createMissionControlServer(deps)` factory creates TWO servers;
  the handler classifies ingress by `req.socket.localPort` — socket
  truth, no header trust needed for the primary boundary.
- cloudflared is retargeted to `http://localhost:$PAIR_MC_REMOTE_PORT`
  in `start-pair-live.sh`. The tunnel can never reach :8788 —
  structural proof, not header inference.
- LAN/remote access preserved: :8790 serves the same UI+API with the
  existing bearer gate (previously :8788 all-interfaces did this).
- Defense-in-depth on the local listener: a request is only `local`
  when remoteAddress is loopback AND no proxy markers exist
  (`cf-*`, `cdn-loop`, `x-forwarded-*`, `forwarded`, `via`,
  `x-real-ip`) AND Host is loopback (`localhost`/`127.0.0.1`/`[::1]`).
  A misconfigured tunnel pointed back at :8788 still classifies remote
  because Cloudflare edge always adds `cf-ray`/`cf-visitor`.
- Residual documented limit: a *different* local proxy that forwards to
  127.0.0.1 while stripping every proxy marker is indistinguishable
  from a local browser — same trust level as the machine itself.
  Operators running such a proxy must keep `PAIR_PERSONAL_MODE=off`.
- `PAIR_PERSONAL_MODE` unset/`off` → single listener on all interfaces,
  byte-identical legacy behavior (rollback path, no data migration).

## Session transport

- `POST /api/personal/session/bootstrap` (local ingress only, opt-in
  mode) mints a random 256-bit session; the server stores only
  `sha256(session_id)` as entity `personal_session:ps_<digest>` — a DB
  read never yields a usable cookie value.
- Cookie `pair_ps`: `HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`;
  `Secure` appended only when the request arrived over https.
- `GET /api/personal/session` — status (mode, ingress, session,
  owner-selection state, eligible businesses). Safe to answer on
  remote: it never mints and reveals nothing beyond config truth.
- `POST /api/personal/session/select-owner {owner}` — one-time explicit
  binding when >1 canonical owner exists.
- `POST /api/personal/session/business` {business_id}` — persists the
  owner-scoped business preference.
- `POST /api/personal/session/logout` — revoke + clear cookie.
- These five routes are exempted from the MC-token gate like the
  outbox/broker lanes; every other `/api/*` route still passes the
  normal gate where a valid session cookie satisfies the *operator*
  class — never admin/broker/outbox/artifact lanes (separate tokens).
- CSRF: SameSite=Strict blocks cross-site sends; additionally every
  session-authenticated mutation and every personal-route POST
  validates `Origin` (must be same-origin to a loopback Host when
  present) and `Sec-Fetch-Site` (must not be `cross-site`/`none` of a
  hostile kind). Header-absent non-browser local clients are allowed —
  they already hold machine-level trust (they can read the token file).

## Owner continuity (canonical seam)

- Binding entity `personal_binding:pb:deployment` persists
  `{operator, business_id, source}` across restarts.
- Resolution on first bootstrap:
  - `biz.objectives.strictEnumerate()` (the canonical strict read the
    cockpit uses) → distinct `owner_authority_id` set.
  - exactly 1 → auto-bind, `source:"derived"`.
  - 0 → mint `operator:personal:<12hex>` persisted, `source:"fresh"`.
  - >1 → `needs_owner_selection` + candidate list → owner picks once →
    `source:"selected"`. Never silently merge/reassign.
- On session-authenticated requests the pinned operator is injected as
  the `operator` transport value. A conflicting `x-operator-id` or
  `body.operator_id` (after canonicalization) fails closed 403
  `FAIL_CLOSED_PERSONAL_OPERATOR_CONFLICT`; matching/absent values are
  fine. Downstream owner-proof services see the canonical identity
  unchanged — no authority semantic changes.
- Eligible businesses = businesses where the bound owner owns ≥1
  objective (strictEnumerate) — never the unfiltered `/api/businesses`
  list. Sole eligible business auto-selects on bootstrap; stale saved
  preference is rejected if no longer eligible.

## UI-V2

- `SessionGate` wraps `appRoute` (not legacy routes): status →
  bootstrap → optional owner picker → render app. Runs before any
  ordinary API/SSE traffic so no transient 401 storms.
- `api.ts`: on 401, one memoized session-ensure + retry; the
  `window.prompt` path only survives when personal mode is unavailable
  (remote/legacy mode).
- `eventBus.ts`: EventSource drops `?token=` whenever a personal
  session is active (cookie is the credential).
- Settings shows `Kết nối hệ thống: Đã kết nối` + operator + mode;
  manual token/operator fields move behind an explicit advanced
  (rollback/remote) disclosure.
- Business switcher auto-restores `pair.business_id` from the session
  binding and offers the server-verified eligible list; manual entry
  stays as fallback.

## Rollback

`PAIR_PERSONAL_MODE` unset/`off` → no personal routes, single listener
on all interfaces, tunnel targets :8788 as before, bearer prompt
behavior unchanged. Persistent entities (`personal_binding`,
`personal_session`) are inert leftovers — removing them is never
required.
