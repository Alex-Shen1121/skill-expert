import { useRef, type ReactNode } from "react";
import { Bot, Cable, Info, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { CodexCliPathSettings } from "./CodexCliPathSettings";
import { SettingsTabs } from "./SettingsTabs";
import { AgentSettings } from "./AgentSettings";
import "./settings.css";

interface SettingsPageProps {
  header: ReactNode;
  general: ReactNode;
  agents: ReactNode;
  connections: ReactNode;
  about: ReactNode;
}

export function SettingsPage({
  header,
  general,
  agents,
  connections,
  about,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const pageRef = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams(location.search);
  const codexTargeted =
    params.get("section") === "codex-cli" ||
    location.hash === "#codex-cli-settings";
  const tabs = [
    {
      key: "general",
      label: t("settings.tabs.general"),
      icon: <SlidersHorizontal size={16} />,
      content: general,
    },
    {
      key: "agents",
      label: t("settings.tabs.agents"),
      icon: <Bot size={16} />,
      content: <AgentSettings sync={agents} onViewChange={scrollToTop} />,
    },
    {
      key: "connections",
      label: t("settings.tabs.connections"),
      icon: <Cable size={16} />,
      content: (
        <>
          <CodexCliPathSettings focusRequested={codexTargeted} />
          {connections}
        </>
      ),
    },
    {
      key: "about",
      label: t("settings.tabs.about"),
      icon: <Info size={16} />,
      content: about,
    },
  ];
  const requested =
    params.get("tab") === "updates" ? "about" : params.get("tab");
  const selected = codexTargeted
    ? "connections"
    : (tabs.find((tab) => tab.key === requested)?.key ?? "general");

  function scrollToTop() {
    pageRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }

  function selectTab(key: string) {
    const next = new URLSearchParams(location.search);
    next.set("tab", key);
    next.delete("section");
    navigate({ search: next.toString(), hash: "" }, { replace: true });
    scrollToTop();
  }

  return (
    <div className="settings-page" ref={pageRef}>
      <div className="app-page-header">{header}</div>
      <SettingsTabs
        id="settings"
        label={t("settings.tabs.label")}
        tabs={tabs}
        selected={selected}
        onSelect={selectTab}
      />
    </div>
  );
}
