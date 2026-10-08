import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
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
import "./styles/app.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/missions/new", element: <MissionNew /> },
      { path: "/missions/:id", element: <MissionDetail /> },
      { path: "/approvals", element: <Approvals /> },
      { path: "/schedules", element: <Schedules /> },
      { path: "/providers", element: <Providers /> },
      { path: "/observability", element: <Observability /> },
      { path: "/objectives", element: <Objectives /> },
      { path: "/chat", element: <Chat /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
