import { AppShell } from "./AppShell";
import { PlannedPage } from "./pages/Planned";

/* /app/* route tree (B.2 sitemap). Every B2–B6 destination exists now as an
   honest placeholder so navigation, deep links and mobile nav are real;
   nothing here fabricates API responses or business data. */

export const appRoute = {
  path: "/app",
  element: <AppShell />,
  children: [
    {
      index: true,
      element: (
        <PlannedPage
          title="Company OS"
          detail="Select a section — Company Cockpit is the owner home and lands in B2."
          phase="B2"
        />
      ),
    },
    {
      path: "company",
      element: (
        <PlannedPage
          title="Company Cockpit"
          detail="The owner's home: business + objective summaries, pending reviews, needs-you lanes. Reads GET /api/vnext/businesses/:id/company (owner-scoped, merged in A1)."
          phase="B2"
        />
      ),
    },
    {
      path: "inbox",
      element: (
        <PlannedPage
          title="Owner Inbox"
          detail="Three lanes — objective reviews pending sign-off, permission approvals, policy halts. HALT aggregation stays unavailable until a backend enumeration exists (API_MISSING — never a fabricated count)."
          phase="B4"
        />
      ),
    },
    {
      path: "objectives",
      element: (
        <PlannedPage
          title="Objectives"
          detail="Owned objective list for the selected business with proven-KPI chips and lifecycle badges."
          phase="B3"
        />
      ),
    },
    {
      path: "objectives/:id",
      element: (
        <PlannedPage
          title="Objective Detail"
          detail="KPI evidence, budget, lifecycle band, CEO workstreams, bound missions, verified artifacts and review history from GET /api/vnext/objectives/:id/cockpit + /reviews."
          phase="B3"
        />
      ),
    },
    {
      path: "objectives/:id/reviews",
      element: (
        <PlannedPage
          title="Objective Reviews"
          detail="Full canonical review history — historical owner_action flags, never presented as current pending."
          phase="B3"
        />
      ),
    },
    {
      path: "ceo",
      element: (
        <PlannedPage
          title="CEO Workspace"
          detail="Explains the autonomous layer: latest pass outcome, strategy revision, decisions via review rows (no dedicated decisions endpoint exists)."
          phase="B4"
        />
      ),
    },
    {
      path: "workforce",
      element: (
        <PlannedPage
          title="AI Workforce"
          detail="Org agents, contracts, effective policy, inboxes and work items for the selected business — plus the legacy admin functions ported from UI_HTML."
          phase="B5"
        />
      ),
    },
    {
      path: "workforce/:id",
      element: (
        <PlannedPage
          title="Agent Detail"
          detail="Contract version, effective-policy summary, current work items and messages for one org agent."
          phase="B5"
        />
      ),
    },
    {
      path: "missions",
      element: (
        <PlannedPage
          title="Mission Operations"
          detail="Mission list with routing and runtime state — ported verbatim from the current dashboard."
          phase="B5"
        />
      ),
    },
    {
      path: "missions/new",
      element: (
        <PlannedPage
          title="Task Entry"
          detail="The golden path — preview → confirm → run, ported verbatim."
          phase="B5"
        />
      ),
    },
    {
      path: "missions/:id",
      element: (
        <PlannedPage
          title="Mission Detail"
          detail="DAG, timeline, evidence, files and mission actions — ported verbatim with an objective backlink where lineage proves one."
          phase="B5"
        />
      ),
    },
    {
      path: "chat",
      element: (
        <PlannedPage
          title="Chat"
          detail="Conversation layer — turns, mission-draft proposals, confirm/reject; ported verbatim."
          phase="B5"
        />
      ),
    },
    {
      path: "system/providers",
      element: (
        <PlannedPage
          title="Providers & Models"
          detail="Provider, model and routing views — ported from the current System surfaces."
          phase="B5"
        />
      ),
    },
    {
      path: "system/observability",
      element: (
        <PlannedPage
          title="Observability"
          detail="Recovery, route decisions and the global event stream — a technical surface, never the company activity feed."
          phase="B5"
        />
      ),
    },
    {
      path: "system/schedules",
      element: (
        <PlannedPage
          title="Schedules"
          detail="Mission schedules CRUD — ported verbatim."
          phase="B5"
        />
      ),
    },
    {
      path: "system/cost",
      element: (
        <PlannedPage
          title="Cost & Usage"
          detail="Cost counters and policy reads — controls land when their backend routes do."
          phase="B5"
        />
      ),
    },
    {
      path: "system/settings",
      element: (
        <PlannedPage
          title="Settings"
          detail="Session token + operator id editor (replaces the 401 window.prompt flow) and theme preference — same localStorage keys, no new auth semantics."
          phase="B5"
        />
      ),
    },
  ],
};
