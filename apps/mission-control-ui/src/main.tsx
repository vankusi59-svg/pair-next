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

/* P15.9-A2 — production cutover to the /app Company OS.
   Production builds redirect legacy routes by default; local Vite dev remains
   legacy-first to preserve development workflows and legacy regression tests.
   The existing per-browser preference has explicit overrides:
     "app"    — use the new UI on any build;
     "legacy" — opt out of the new UI on any build (emergency rollback).
   An absent/unknown key uses the build default, never grants authority.
   Legacy routes, including dynamic mission IDs and query/hash, remain intact
   behind the override. Unmapped routes such as /ui are not redirected. */
const LEGACY_REDIRECT_FLAG = "pair.legacy_redirect";
const legacyRedirectOn = () => {
  const preference = localStorage.getItem(LEGACY_REDIRECT_FLAG);
  if (preference === "app") return true;
  if (preference === "legacy") return false;
  return import.meta.env.PROD;
};

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
      { path: "/", element: <OptInRedirect to="/app/company"><Dashboard /></OptInRedirect> },
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
