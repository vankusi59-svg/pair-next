import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { MissionDetail } from "./pages/MissionDetail";
import { MissionNew } from "./pages/MissionNew";
import { Approvals } from "./pages/Approvals";
import { Schedules } from "./pages/Schedules";
import { Providers } from "./pages/Providers";
import { Observability } from "./pages/Observability";
import { Objectives } from "./pages/Objectives";
import { Chat } from "./pages/Chat";
import { appRoute } from "./app/routes";
import "./styles/app.css";
import "./styles/tokens.css";

/* P15.9-B6 Scope H — dormant, opt-in legacy→/app redirect. The flag is a
   browser-local opt-in ONLY: localStorage "pair.legacy_redirect" === "app".
   Default is OFF — no deployment config changes, no auto-enable, "/" keeps
   rendering the legacy Dashboard. Targets are proven-parity destinations;
   dynamic IDs and query/hash are preserved; unmapped routes never redirect
   (no loops — /app/* is outside the legacy tree). Reverting the flag
   restores legacy behavior. */
const LEGACY_REDIRECT_FLAG = "pair.legacy_redirect";
const legacyRedirectOn = () => localStorage.getItem(LEGACY_REDIRECT_FLAG) === "app";

function OptInRedirect({ to, children }: { to: string | ((id: string | undefined) => string); children: React.ReactNode }) {
  const loc = useLocation();
  const params = useParams();
  if (!legacyRedirectOn()) return <>{children}</>;
  const target = typeof to === "function" ? to(params.id) : to;
  return <Navigate to={target + loc.search + loc.hash} replace />;
}

const router = createBrowserRouter([
  appRoute,
  {
    element: <Layout />,
    children: [
      { path: "/", element: <OptInRedirect to="/app/missions"><Dashboard /></OptInRedirect> },
      { path: "/missions/new", element: <OptInRedirect to="/app/missions/new"><MissionNew /></OptInRedirect> },
      { path: "/missions/:id", element: <OptInRedirect to={(id) => `/app/missions/${id}`}><MissionDetail /></OptInRedirect> },
      { path: "/approvals", element: <OptInRedirect to="/app/inbox"><Approvals /></OptInRedirect> },
      { path: "/schedules", element: <OptInRedirect to="/app/system/schedules"><Schedules /></OptInRedirect> },
      { path: "/providers", element: <OptInRedirect to="/app/system/providers"><Providers /></OptInRedirect> },
      { path: "/observability", element: <OptInRedirect to="/app/system/observability"><Observability /></OptInRedirect> },
      { path: "/objectives", element: <OptInRedirect to="/app/objectives"><Objectives /></OptInRedirect> },
      { path: "/chat", element: <OptInRedirect to="/app/chat"><Chat /></OptInRedirect> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
