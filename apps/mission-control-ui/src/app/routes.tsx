import { Navigate } from "react-router-dom";
import { AppShell } from "./AppShell";
import { SessionGate } from "./SessionGate";
import { Home } from "./pages/Home";
import { Intake } from "./pages/Intake";
import { Company } from "./pages/Company";
import { ObjectiveDetail } from "./pages/ObjectiveDetail";
import { ObjectiveList } from "./pages/ObjectiveList";
import { Inbox } from "./pages/Inbox";
import { Ceo } from "./pages/Ceo";
import { Reviews } from "./pages/Reviews";
import { Workforce } from "./pages/Workforce";
import { AgentDetail } from "./pages/AgentDetail";
import { WorkforceAdmin } from "./pages/WorkforceAdmin";
import { BusinessAdmin } from "./pages/BusinessAdmin";
import { Missions } from "./pages/Missions";
import { MissionNew } from "./pages/MissionNew";
import { MissionDetailPage } from "./pages/MissionDetail";
import Chat from "./pages/Chat";
import { SystemProviders } from "./pages/SystemProviders";
import { SystemObservability } from "./pages/SystemObservability";
import { SystemSchedules } from "./pages/SystemSchedules";
import { SystemCost } from "./pages/SystemCost";
import { SystemSettings } from "./pages/SystemSettings";

/* /app/* route tree (B.2 sitemap). Every B2–B6 destination exists now as an
   honest placeholder so navigation, deep links and mobile nav are real;
   nothing here fabricates API responses or business data. */

export const appRoute = {
  path: "/app",
  element: <SessionGate><AppShell /></SessionGate>,
  children: [
    {
      index: true,
      // UI-V2: /app lands on the owner home (Tổng quan). /app/company
      // stays as the advanced cockpit — every old deep link resolves.
      element: <Navigate to="/app/home" replace />,
    },
    {
      path: "home",
      element: <Home />,
    },
    {
      path: "new",
      element: <Intake />,
    },
    {
      path: "company",
      element: <Company />,
    },
    {
      path: "inbox",
      element: <Inbox />,
    },
    {
      path: "objectives",
      element: <ObjectiveList />,
    },
    {
      path: "objectives/:id",
      element: <ObjectiveDetail />,
    },
    {
      path: "objectives/:id/reviews",
      element: <Reviews />,
    },
    {
      path: "ceo",
      element: <Ceo />,
    },
    {
      path: "workforce/admin",
      element: <WorkforceAdmin />,
    },
    {
      path: "workforce",
      element: <Workforce />,
    },
    {
      path: "workforce/:id",
      element: <AgentDetail />,
    },
    {
      path: "missions/new",
      element: <MissionNew />,
    },
    {
      path: "missions/:id",
      element: <MissionDetailPage />,
    },
    {
      path: "missions",
      element: <Missions />,
    },
    {
      path: "chat",
      element: <Chat />,
    },
    {
      path: "system/business-admin",
      element: <BusinessAdmin />,
    },
    {
      path: "system/providers",
      element: <SystemProviders />,
    },
    {
      path: "system/observability",
      element: <SystemObservability />,
    },
    {
      path: "system/schedules",
      element: <SystemSchedules />,
    },
    {
      path: "system/cost",
      element: <SystemCost />,
    },
    {
      path: "system/settings",
      element: <SystemSettings />,
    },
  ],
};
