import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { i18nReady } from "./i18n";
import { logStartupEvent } from "./lib/tauri";
import "./index.css";
import App from "./App.tsx";

const root = createRoot(document.getElementById("root")!);

if (import.meta.env.MODE === "agent-skills-settings-prototype") {
  const { AgentSkillsSettingsPrototype } = await import(
    "./views/prototypes/AgentSkillsSettingsPrototype"
  );
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AgentSkillsSettingsPrototype />
      </BrowserRouter>
    </StrictMode>,
  );
} else {
  await i18nReady;
  logStartupEvent("i18n_ready", performance.now()).catch(() => {});
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  logStartupEvent("root_rendered", performance.now()).catch(() => {});
}
