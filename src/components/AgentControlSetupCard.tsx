import { useEffect, useMemo, useState } from "react";
import { Loader2, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApp } from "../context/AppContext";
import { getErrorMessage } from "../lib/error";
import * as api from "../lib/tauri";
import { AgentIcon } from "./AgentIcon";
import {
  AGENT_SKILLS_ONBOARDING_SETTING_KEY,
  ensureTrustedManagementSkill,
  isTrustedManagementSkill,
  markAgentSkillsOnboardingComplete,
  MANAGEMENT_SKILL_NAME,
} from "../lib/agentSkillsManagement";

/**
 * 一次性告知用户 Agent 可以直接管理共享技能库。
 * 至少一个 Agent 已成功部署或用户关闭提示后不再显示；Agent 选择默认留空，避免一次点击部署到全部环境。
 */
export function AgentControlSetupCard() {
  const { t } = useTranslation();
  const { tools, managedSkills, loading, refreshManagedSkills } = useApp();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const managementSkill = useMemo(
    () => managedSkills.find(isTrustedManagementSkill) ?? null,
    [managedSkills],
  );
  const configured = (managementSkill?.targets.length ?? 0) > 0;
  const hasSourceConflict = useMemo(
    () =>
      managedSkills.some(
        (skill) =>
          skill.name === MANAGEMENT_SKILL_NAME && !isTrustedManagementSkill(skill),
      ),
    [managedSkills],
  );
  const candidates = useMemo(
    () => tools.filter((tool) => tool.installed && tool.enabled),
    [tools],
  );

  useEffect(() => {
    void api
      .getSettings(AGENT_SKILLS_ONBOARDING_SETTING_KEY)
      .catch(() => null)
      .then((flag) => setDismissed(Boolean(flag)));
  }, []);

  if (loading || dismissed === null || dismissed || configured) return null;

  const dismiss = async () => {
    setDismissed(true);
    await api
      .setSettings(AGENT_SKILLS_ONBOARDING_SETTING_KEY, "dismissed")
      .catch(() => {});
  };

  const toggle = (key: string) => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const enable = async () => {
    if (busy || selected.length === 0) return;
    if (hasSourceConflict) {
      toast.error(t("agentControl.sourceConflict"));
      return;
    }
    setBusy(true);
    try {
      const installed = await ensureTrustedManagementSkill(managedSkills);
      if (!installed) throw new Error(t("agentControl.errorNotFound"));

      for (const key of selected) {
        await api.syncSkillToTool(installed.id, key);
      }
      toast.success(t("agentControl.done", { count: selected.length }));
      await markAgentSkillsOnboardingComplete();
    } catch (error) {
      toast.error(getErrorMessage(error, t("agentControl.errorGeneric")));
    } finally {
      // 即使部分部署失败也刷新；Skill 可能已经入库，下一步应从技能卡继续处理。
      await refreshManagedSkills();
      setBusy(false);
    }
  };

  return (
    <div className="app-panel p-4 transition-colors hover:border-border">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md border border-border-subtle bg-accent-bg p-2 text-accent-light">
          <Terminal className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-primary">
            {t("agentControl.title")}
          </h3>
          <p className="mt-0.5 text-[12px] leading-5 text-muted">
            {t("agentControl.body")}
          </p>

          {expanded && (
            <div className="mt-3">
              <p className="app-section-title mb-2">{t("agentControl.pickAgents")}</p>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((tool) => {
                  const active = selected.includes(tool.key);
                  return (
                    <button
                      type="button"
                      key={tool.key}
                      onClick={() => toggle(tool.key)}
                      disabled={busy}
                      aria-pressed={active}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all duration-150 disabled:opacity-50 ${
                        active
                          ? "border-accent bg-accent-bg text-accent"
                          : "border-border-subtle bg-surface-active text-muted"
                      }`}
                    >
                      <AgentIcon
                        agentKey={tool.key}
                        displayName={tool.display_name}
                        className="h-4 w-4 rounded-[4px]"
                      />
                      {tool.display_name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {expanded ? (
            <button
              type="button"
              onClick={enable}
              disabled={busy || selected.length === 0}
              className="app-button-primary h-[34px] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {selected.length === 0
                ? t("agentControl.confirmEmpty")
                : t("agentControl.confirm", { count: selected.length })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="app-button-secondary h-[34px]"
            >
              {t("agentControl.cta")}
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            title={t("agentControl.dismiss")}
            aria-label={t("agentControl.dismiss")}
            className="rounded-md p-1.5 text-faint transition-colors duration-150 hover:bg-surface-active hover:text-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
