import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { MobileApp } from "./MobileApp";
import { createApiTransport } from "./apiTransport";
import { DeviceSecurityGate } from "./DeviceSecurityGate";
import "./app.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element.");

const demo = import.meta.env.DEV && import.meta.env.VITE_TOMVERSE_DEMO === "true";
const transport = demo
  ? (await import("./demoTransport")).createDemoTransport()
  : createApiTransport();
createRoot(container).render(
  <StrictMode>
    <DeviceSecurityGate transport={transport}><MobileApp transport={transport} demo={demo} /></DeviceSecurityGate>
  </StrictMode>
);
