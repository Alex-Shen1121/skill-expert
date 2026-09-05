import { type ReactNode } from "react";
import { ArrowDownToLine, Sparkles, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { AgentSkillsManagementSettings } from "../AgentSkillsManagementSettings";
import { SettingsTabs } from "./SettingsTabs";

export function AgentSettings({
  sync,
  onViewChange,
}: {
  sync: ReactNode;
  onViewChange: () => void;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const selected =
    params.get("agentView") === "management" ? "management" : "sync";
  const tabs = [
    {
      key: "sync",
      label: t("settings.agentPurpose.sync"),
      description: t("settings.agentPurpose.syncDescription"),
      icon: <ArrowDownToLine size={19} strokeWidth={1.6} />,
      content: (
        <>
          <div className="settings-agent-explanation">
            <Zap size={15} aria-hidden="true" />
            <div>
              <strong>{t("settings.agentPurpose.immediate")}</strong>
              <p>{t("settings.agentPurpose.immediateDescription")}</p>
            </div>
          </div>
          {sync}
        </>
      ),
    },
    {
      key: "management",
      label: t("agentManagement.title"),
      description: t("settings.agentPurpose.managementDescription"),
      icon: <Sparkles size={19} strokeWidth={1.6} />,
      content: (
        <>
          <div className="settings-agent-explanation">
            <Sparkles size={15} aria-hidden="true" />
            <div>
              <strong>{t("settings.agentPurpose.apply")}</strong>
              <p>{t("settings.agentPurpose.applyDescription")}</p>
            </div>
          </div>
          <AgentSkillsManagementSettings />
        </>
      ),
    },
  ];
  return (
    <div className="settings-agent-setup">
      <SettingsTabs
        id="agent-purpose"
        label={t("settings.agentPurpose.label")}
        purposes
        tabs={tabs}
        selected={selected}
        onSelect={(key) => {
          setParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              next.set("agentView", key);
              return next;
            },
            { replace: true },
          );
          onViewChange();
        }}
      />
    </div>
  );
}
