# C — Design System

Direction: professional enterprise SaaS — clean layout, modern sidebar, strong
typography, light/dark, responsive. **No new frontend dependency at B0**; all
tokens/components below are implementable in plain CSS + the existing React
stack (CSS custom properties + `data-theme`, same mechanism as today).

## C.1 Color tokens

Two themes via `[data-theme="light"|"dark"]` custom properties. Tokens are
semantic — components never use raw hues.

```css
/* dark (default) */
--bg-app: #0d1117;      --bg-surface: #161b22;   --bg-raised: #1c2330;
--bg-inset: #0a0e14;    --border: #2b3442;       --border-strong:#3d4859;
--text-1: #e8edf4;      --text-2: #9aa7b8;       --text-3: #66707f;
--accent: #4f8cff;      --accent-strong:#6ba0ff; --accent-soft:rgba(79,140,255,.14);
/* semantic status */
--ok:     #34c07c;  --ok-soft:   rgba(52,192,124,.14);
--warn:   #e3a72f;  --warn-soft: rgba(227,167,47,.14);
--danger: #e5534b;  --danger-soft:rgba(229,83,75,.14);
--info:   #4fb6d9;  --info-soft: rgba(79,182,217,.14);
--purple: #9d7bd8;  --purple-soft:rgba(157,123,216,.14);
--unknown:#6e7681;  --unknown-soft:rgba(110,118,129,.16);
/* light overrides on [data-theme="light"] — same token names */
```

Status→token mapping is normative (D references these names):

| Meaning | Token | Examples |
|---|---|---|
| Proven / healthy / DONE / ACHIEVED / MET (proven) | `--ok` | work item DONE, KPI MET with `canonically_proven:true` |
| Pending attention / waiting / paused | `--warn` | approval pending, EXPIRY_PENDING, INTERVENTION |
| Danger / failed / halted / denied | `--danger` | FAILED, HALT, QUARANTINE, 403 denial shown to owner |
| Informational / running / in-flight | `--info` | RUNNING, IN_PROGRESS, streaming |
| Authority/decision/purple ops | `--purple` | CANDIDATE review, CEO decision, policy ENABLED |
| Unverifiable / unknown / not proven | `--unknown` | `UNVERIFIED` assessment, `observation_error`, missing binding |

## C.2 Typography

System stack only (no webfont dependency):

```
font-family: -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

| Role | Size / weight / tracking |
|---|---|
| Display (cockpit headline) | 28 / 700 / -0.02 |
| H1 page title | 22 / 700 / -0.01 |
| H2 section | 16 / 650 |
| Body | 14 / 400 |
| Small/muted | 12.5 / 400 (text-2) |
| Micro/eyebrow labels | 11 / 650, uppercase, +0.06em |
| Numeric/KPI figures | mono 15 / 600 tabular-nums |
| Canonical codes (`FAIL_CLOSED_*`) | mono 12.5 — always paired with a human gloss |

Rule: raw IDs (`MSN_…`, `DL_…`, `OBJ_…`) render mono, truncated to last-8 with
full copy-on-hover — never the primary label of anything owner-facing.

## C.3 Spacing / grid / breakpoints

- 4px base unit; scale 4, 8, 12, 16, 20, 24, 32, 48.
- App grid: `sidebar(240px) | content(max 1440px, padding 24)` — sidebar
  collapsible to 64px icon rail on medium widths.
- Cards: radius 10, 1px `--border`, padding 16/20; no shadows in dark theme,
  hairline shadow only in light.
- Breakpoints: `≥1200` full grid; `768–1199` icon-rail sidebar, 2-col cards;
  `<768` bottom tab bar, single column, cards full-bleed padding 12;
  tables → stacked label:value rows below 640 (`data-label` pattern).

## C.4 Component vocabulary (extends existing primitives)

Keep `Badge`, `Timeline`, `Dag`, `Toast`. Add (plain React + CSS, no deps):

- **AppShell** — sidebar + topbar slot + `<Outlet>`; owns business switcher +
  inbox badge + operator chip + theme toggle.
- **KpiBar** — progress bar baseline→current→target; shows `MET (proven)`,
  `GAP`, `UNVERIFIED` state; direction-aware (AT_LEAST/AT_MOST/EXACT).
- **StatusBadge** — the ONE badge component; props `{tone, label, gloss}` —
  every canonical code pairs with a one-line human gloss (§C.6).
- **ProofChip** — `canonically_proven` renderer: `proven` (ok), `claimed`
  (info), `unverifiable` (unknown) — never a bare checkmark.
- **EntityCard** — title + status + 2-4 metric slots + footer actions;
  objectives, missions, agents share it.
- **DataTable** — responsive table with `data-label` collapse, sortable
  headers, sticky header; row click → detail route.
- **FilterBar** — text + enum filters; never writes filters into URLs it
  doesn't also read (deep-linkable state).
- **EmptyState / ErrorState / DeniedState / UnverifiedPanel** — the four named
  empty-family states (§C.5).
- **ConfirmDialog** — for every mutating action; states the canonical verb +
  consequence + reason field when the API takes one.
- **Skeleton** — shimmer blocks matching card/table shapes.

## C.5 State vocabulary (normative — reuse everywhere)

| State | When | Presentation |
|---|---|---|
| Loading | first paint / refetch | Skeleton, never spinner-only > 2s |
| Empty | API 200, zero rows | EmptyState: what it is + how to create the first |
| Error | API error, transport | ErrorState: canonical code + gloss + retry |
| Unauthorized | 401/403 | DeniedState: "session/token or ownership" explanation + path to fix (re-enter token in Settings); never a silent redirect |
| Unverified | `canonically_proven:false`, `observation_error`, dropped artifacts | UnverifiedPanel: what couldn't be proven + why + that claims are shown as claims; NEVER a MET/verified badge |

**No-write honesty**: read projections that are stale or unverifiable must
render as such; the UI never synthesizes "verified" from raw claims (the
`canonically_proven` contract).

## C.6 Canonical-code gloss convention

Every `FAIL_CLOSED_*` / outcome code renders as `<StatusBadge>` = code (mono)
+ gloss line. Gloss catalog is a single `lib/gloss.ts` map maintained
alongside new endpoints — e.g.
`FAIL_CLOSED_COMPANY_SCOPE → "You don't own any objectives in this business"`,
`OBJECTIVE_TERMINAL → "The objective already reached a final state"`.

## C.7 Accessibility rules

- Color is never the only signal — badges always carry a text label.
- Contrast ≥ 4.5:1 for text, ≥ 3:1 for large text/icon states in BOTH themes.
- Full keyboard path: skip-link exists (already), sidebar `nav` landmarks,
  focus ring 2px `--accent-strong` on `:focus-visible`, modals trap focus,
  `Esc` closes, arrow-key navigation in menus/tabs.
- `aria-live="polite"` on inbox badge + toast region (Toast already exists —
  reuse).
- Tables use real `<th scope>`, sort buttons labelled; DAG/timeline gets a
  text-fallback list.
- `prefers-reduced-motion`: disable shimmer/transition.
- Hit targets ≥ 40×40 CSS px on mobile.
