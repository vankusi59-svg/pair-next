import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { MissionDetail } from "./pages/MissionDetail";
import { MissionNew } from "./pages/MissionNew";
import { Approvals } from "./pages/Approvals";
import { Providers } from "./pages/Providers";
import "./styles/app.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/missions/new", element: <MissionNew /> },
      { path: "/missions/:id", element: <MissionDetail /> },
      { path: "/approvals", element: <Approvals /> },
      { path: "/providers", element: <Providers /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
