import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ReadinessScreen } from "./ReadinessScreen";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element.");

createRoot(container).render(
  <StrictMode>
    <ReadinessScreen />
  </StrictMode>
);
