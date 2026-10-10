# H — Final Acceptance Matrix

Gates for the P15.9-B line (checked at B6 / cutover PR). Every row maps to a
verifiable check; "n/a" must be justified in the PR, not skipped.

## H.1 Functional parity (old app)

| Capability | Where in new UI | Gate |
|---|---|---|
| Dashboard missions + routing + cost chips | `/app/missions`, `/app/company`, `/app/system/cost` | e2e smoke |
| Mission preview→confirm→run | `/app/missions/new` | e2e golden path |
| Mission detail + DAG/timeline/evidence/files + pause/resume/cancel/ack | `/app/missions/:id` | e2e |
| Approvals approve/deny | `/app/inbox` | e2e |
| Schedules CRUD | `/app/system/schedules` | e2e |
| Providers/models/routes | `/app/system/providers` | e2e |
| Observability + SSE stream | `/app/system/observability` | e2e |
| Objectives list/create + ceo-cycle + auto-policy | `/app/objectives*` | e2e |
| Chat turns + drafts + confirm/reject | `/app/chat` | existing chat spec ported |
| Business/org-agent/work-item admin (legacy `UI_HTML`) | `/app/workforce` + `/app/system` admin forms | manual matrix — port BEFORE cutover |
| Token + operator session | `/app/system/settings` (+same localStorage keys) | manual |

## H.2 UI visual consistency

| Check | Gate |
|---|---|
| All badges render via `StatusBadge`/`ProofChip` with gloss | per-page snapshot review |
| Light + dark themes pass token audit (no raw hues) | visual pass both themes |
| Numeric/tabular figures use mono tabular-nums | visual |
| Canonical codes always paired with gloss | code review grep for raw `error` renders |

## H.3 Responsive

| Breakpoint | Gate |
|---|---|
| ≥1200 sidebar + full grid | e2e viewport |
| 768–1199 icon rail | e2e viewport |
| <768 bottom tab bar, stacked cards, table collapse | e2e viewport |

## H.4 Accessibility

| Check | Gate |
|---|---|
| Keyboard: skip-link, nav landmarks, dialog trap, Esc, focus ring | manual keyboard pass per screen |
| aria-live inbox badge + toasts | DOM check |
| Contrast ≥4.5/3 both themes | token audit |
| `prefers-reduced-motion` honored | manual |
| 40px mobile hit targets | e2e viewport check |

## H.5 E2E

| Flow | Gate |
|---|---|
| Old-app smoke (existing specs) | pass unmodified every PR |
| `/app` smoke (shell, cockpit, detail, inbox, missions, chat) | new specs per B-PR |
| Denied (403) on foreign business/objective | negative e2e |
| UNVERIFIED/observation_error render | seeded e2e |

## H.6 Authority preservation

| Rule | Gate |
|---|---|
| `x-operator-id` is sole actor source; no body-field actor anywhere | code review |
| No UI-invented permissions; every button maps to an existing POST | E-mapping review |
| No new authority semantics; disabled-until-A2 buttons are honest | code review |
| No secrets/tokens rendered; credential state = configured/unconfigured | visual + review |
| No company feed from global SSE | code review |
| Optimistic UI: none — canonical refetch after every POST | code review |

## H.7 No regression to existing operations

| Check | Gate |
|---|---|
| Backend untouched by B-PRs (UI-only diffs) except new read routes explicitly approved | diff review |
| `UI_HTML` reachable until cutover sign-off | manual |
| Old routes work during coexistence | e2e each PR |
| verify:change READY_FOR_INDEPENDENT_AUDIT on every PR | harness |
| Independent audit + Owner approval before any merge | process |
