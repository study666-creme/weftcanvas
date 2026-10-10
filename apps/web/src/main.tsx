import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";

import { App } from "./App";
import { AppStartupBoundary } from "./components/app-startup-boundary";
import { installCanvasReleaseFreshnessGuard } from "./lib/canvas-release-freshness";
import "./styles.css";
import "./entry-gate.css";
import "./canvas-entry-loader.css";
import "./appearance-panel.css";
import "./app-cursor.css";
import "./canvas-effects.css";
import "./airy-theme.css";
import "./ink-scheme.css";
import "./imax-theme.css";
import "./onyx-scheme.css";
import "./onyx-theme.css";
import "./emerald-edge.css";
import "./ui-polish.css";
import "./quiet-generation.css";
import "./wallet-premium.css";
import "./cloud-resource.css";

installCanvasReleaseFreshnessGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppStartupBoundary>
      <App />
    </AppStartupBoundary>
  </StrictMode>,
);
