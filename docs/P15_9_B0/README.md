# P15.9-B0 — Full UI/UX Redesign Master Plan

**Status:** DESIGN ONLY — `PENDING_OWNER_DESIGN_REVIEW`. Do not merge. Do not deploy.
**BASE:** `2232955b6d3b53e21159a18570e47beb51cf74c8` (`staging/pr59-safe`, post PR #91)
**Scope:** Redesign PAIR Next from a technical Mission Control into an AI Company
Operating System. No UI code in this deliverable; no frontend dependencies added;
no production routes changed; legacy UI untouched.

## Document map

| Doc | Content |
|---|---|
| [A-current-ui-audit.md](A-current-ui-audit.md) | Route/page inventory, reusable parts, UX problems, functional preservation matrix, feature classification (EXISTS / API_READY / API_MISSING / FUTURE). |
| [B-information-architecture.md](B-information-architecture.md) | Target sitemap, sidebar hierarchy, old→new route migration map, owner-first navigation. |
| [C-design-system.md](C-design-system.md) | Color tokens, typography, spacing/grid/breakpoints, components, state language (incl. UNVERIFIED / fail-closed / unauthorized), accessibility rules. |
| [D-screen-specifications.md](D-screen-specifications.md) | Per-screen specs + ASCII wireframes (desktop & mobile) for all core screens. |
| [E-api-to-ui-mapping.md](E-api-to-ui-mapping.md) | Component → canonical API mapping, source of truth, authority, error states, missing capabilities. |
| [F-migration-strategy.md](F-migration-strategy.md) | Parallel-route strategy, rollback, no-duplicate-logic rule, cutover gates. |
| [G-implementation-roadmap.md](G-implementation-roadmap.md) | PR sequence (B1..B6 + A2 dependency), scope/files/deps/risks/verification/acceptance per PR. |
| [H-acceptance-matrix.md](H-acceptance-matrix.md) | Final acceptance matrix: parity, visual, responsive, a11y, E2E, authority preservation, no-regression. |

## One-paragraph design thesis

The company owner reads *business truth*, not *system internals*. The shell is a
sidebar-first enterprise SaaS where **Company Cockpit** is the home; **Objectives**
carry KPI/budget/deadline/workstream/mission/artifact/review depth; **CEO
Workspace** explains what the autonomous layer decided and why; **AI Workforce**
lists the org agents as employees; **Owner Inbox** is the single queue of pending
approvals and `owner_action_required` reviews; **Mission Ops** and **Chat** keep
the current golden-path experience; **System & Settings** absorbs Providers /
Observability / Schedules / technical routes. Every status badge distinguishes
proven-vs-claimed-vs-unverifiable — the UI never renders an unproven claim as
verified (mirrors the R1–R3c audit contract of the merged cockpit APIs).
