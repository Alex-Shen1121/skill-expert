import {
  Check,
  ExternalLink,
  Loader2,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useApp } from "../context/AppContext";
import type { ManagedSkill } from "../lib/tauri";
import * as api from "../lib/tauri";
import {
  ensureTrustedManagementSkill,
  isTrustedManagementSkill,
  markAgentSkillsOnboardingComplete,
  MANAGEMENT_SKILL_NAME,
} from "../lib/agentSkillsManagement";
import { AgentIcon } from "./AgentIcon";

interface ManagementTarget {
  key: string;
  displayName: string;
  active: boolean;
  selected: boolean;
}

type TargetFilter = "all" | "deployed" | "available" | "attention";

interface TargetOperation {
  key: string;
  displayName: string;
  enable: boolean;
}

type ManagementSourceState = "conflict" | "trusted" | "notInstalled";

const SOURCE_STATE_VIEW = {
  conflict: {
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700",
    statusKey: "agentManagement.conflictStatus",
    descriptionKey: "agentManagement.conflictDescription",
  },
  trusted: {
    className: "border-emerald-500/20 bg-white/75 text-emerald-700",
    statusKey: "agentManagement.trustedStatus",
    descriptionKey: "agentManagement.trustedDescription",
  },
  notInstalled: {
    className: "border-border-subtle bg-white/75 text-muted",
    statusKey: "agentManagement.notInstalledStatus",
    descriptionKey: "agentManagement.notInstalledDescription",
  },
} as const;

export function AgentSkillsManagementSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    tools,
    managedSkills,
    refreshManagedSkills,
    openSkillDetailById,
  } = useApp();
  const [draftTargetKeys, setDraftTargetKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [targetFilter, setTargetFilter] = useState<TargetFilter>("all");
  const [failedOperations, setFailedOperations] = useState<TargetOperation[]>([]);
  const managementSkill = managedSkills.find(isTrustedManagementSkill) ?? null;
  const conflictingSkill =
    managedSkills.find(
      (skill) =>
        skill.name === MANAGEMENT_SKILL_NAME && !isTrustedManagementSkill(skill),
    ) ?? null;
  const sameNameSkill = conflictingSkill ?? managementSkill;
  const hasSourceConflict = conflictingSkill !== null;
  const sourceState: ManagementSourceState = hasSourceConflict
    ? "conflict"
    : managementSkill
      ? "trusted"
      : "notInstalled";
  const sourceView = SOURCE_STATE_VIEW[sourceState];
  const targetKeys = useMemo(
    () => new Set(managementSkill?.targets.map((target) => target.tool) ?? []),
    [managementSkill],
  );
  const targetSignature = useMemo(
    () => [...targetKeys].sort().join("\n"),
    [targetKeys],
  );

  useEffect(() => {
    setDraftTargetKeys(new Set(targetKeys));
  }, [targetSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = useMemo<ManagementTarget[]>(() => {
    const activeTools = tools.filter((tool) => tool.installed && tool.enabled);
    const activeKeys = new Set(activeTools.map((tool) => tool.key));
    const result: ManagementTarget[] = activeTools.map((tool) => ({
      key: tool.key,
      displayName: tool.display_name,
      active: true,
      selected: draftTargetKeys.has(tool.key),
    }));

    for (const target of managementSkill?.targets ?? []) {
      if (activeKeys.has(target.tool)) continue;
      const knownTool = tools.find((tool) => tool.key === target.tool);
      result.push({
        key: target.tool,
        displayName: knownTool?.display_name ?? target.tool,
        active: false,
        selected: draftTargetKeys.has(target.tool),
      });
    }

    return result;
  }, [draftTargetKeys, managementSkill, tools]);

  const additions = targets.filter(
    (target) => target.selected && !targetKeys.has(target.key),
  );
  const removals = targets.filter(
    (target) => !target.selected && targetKeys.has(target.key),
  );
  const hasChanges = additions.length > 0 || removals.length > 0;
  const pendingChangeCount = additions.length + removals.length;
  const pendingOperations: TargetOperation[] = [
    ...additions.map((target) => ({
      key: target.key,
      displayName: target.displayName,
      enable: true,
    })),
    ...removals.map((target) => ({
      key: target.key,
      displayName: target.displayName,
      enable: false,
    })),
  ];
  const visiblePendingOperations = pendingOperations.slice(0, 3);
  const hiddenPendingOperationCount =
    pendingOperations.length - visiblePendingOperations.length;
  const failedTargetKeys = new Set(
    failedOperations.map((operation) => operation.key),
  );
  const attentionCount = targets.filter(
    (target) => !target.active && targetKeys.has(target.key),
  ).length;
  const availableCount = targets.filter(
    (target) => target.active && !target.selected,
  ).length;
  const filteredTargets = targets.filter((target) => {
    if (!target.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) {
      return false;
    }
    if (targetFilter === "deployed") return target.selected;
    if (targetFilter === "available") return target.active && !target.selected;
    if (targetFilter === "attention") {
      return !target.active && targetKeys.has(target.key);
    }
    return true;
  });

  const toggleTarget = (key: string) => {
    setFailedOperations([]);
    setDraftTargetKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runOperations = async (
    skill: ManagedSkill,
    operations: TargetOperation[],
  ): Promise<{ failed: TargetOperation[]; targetDelta: number }> => {
    const failed: TargetOperation[] = [];
    let targetDelta = 0;
    for (const operation of operations) {
      try {
        if (operation.enable) {
          await api.syncSkillToTool(skill.id, operation.key);
          targetDelta += 1;
        } else {
          await api.unsyncSkillFromTool(skill.id, operation.key);
          targetDelta -= 1;
        }
      } catch {
        failed.push(operation);
      }
    }
    return { failed, targetDelta };
  };

  const applyChanges = async () => {
    if (busy || hasSourceConflict || !hasChanges) return;
    if (removals.length > 0) {
      const confirmed = await dialogConfirm(
        t("agentManagement.removeConfirm", {
          names: removals.map((target) => target.displayName).join("、"),
        }),
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      const resolvedSkill = await ensureTrustedManagementSkill(managedSkills);
      if (!resolvedSkill) throw new Error(t("agentManagement.errorNotFound"));
      const result = await runOperations(resolvedSkill, pendingOperations);
      setFailedOperations(result.failed);
      const finalTargetCount = targetKeys.size + result.targetDelta;
      if (finalTargetCount > 0) {
        await markAgentSkillsOnboardingComplete();
      }
      await refreshManagedSkills();
      if (result.failed.length > 0) {
        toast.error(t("agentManagement.applyFailed"));
      } else {
        toast.success(t("agentManagement.applySuccess"));
      }
    } catch {
      await refreshManagedSkills();
      toast.error(t("agentManagement.applyFailed"));
    } finally {
      setBusy(false);
    }
  };

  const retryFailedOperations = async () => {
    if (busy || !managementSkill || failedOperations.length === 0) return;
    setBusy(true);
    try {
      const result = await runOperations(managementSkill, failedOperations);
      setFailedOperations(result.failed);
      await refreshManagedSkills();
      if (result.failed.length > 0) {
        toast.error(t("agentManagement.applyFailed"));
      } else {
        toast.success(t("agentManagement.retrySuccess"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="app-section-title">{t("agentManagement.title")}</h2>
          <p className="mt-1 text-[12px] text-muted">{t("agentManagement.subtitle")}</p>
        </div>
        <span className="rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-muted">
          {t("agentManagement.deployedCount", { count: targetKeys.size })}
        </span>
      </div>

      <div className="grid grid-cols-[0.86fr_1.4fr] gap-3">
        <div className="relative overflow-hidden rounded-2xl border border-accent-border bg-[linear-gradient(145deg,#f0fdf7_0%,#ffffff_56%,#ecfdf5_100%)] p-4 shadow-[0_12px_30px_rgba(5,150,105,0.08)]">
          <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-emerald-300/25 blur-2xl" />
          <div className="relative">
            <div className="flex items-center justify-between gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent-border bg-white/80 text-accent shadow-sm">
                <Sparkles className="h-4 w-4" />
              </span>
              <span
                className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${sourceView.className}`}
              >
                {t(sourceView.statusKey)}
              </span>
            </div>
            <p className="mt-8 text-[11px] uppercase tracking-[0.12em] text-emerald-700/60">
              {t("agentManagement.skillLabel")}
            </p>
            <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-primary">
              {MANAGEMENT_SKILL_NAME}
            </h3>
            <p className="mt-2 text-[11px] leading-5 text-muted">
              {t(sourceView.descriptionKey)}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <div
                aria-label={t("agentManagement.metricLabel", {
                  label: t("agentManagement.currentDeployments"),
                  count: targetKeys.size,
                })}
                className="rounded-xl border border-emerald-500/15 bg-white/70 p-3 shadow-sm shadow-emerald-900/[0.03]"
              >
                <p className="text-[10px] text-muted">
                  {t("agentManagement.currentDeployments")}
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-primary">
                  {targetKeys.size}
                </p>
              </div>
              <div
                aria-label={t("agentManagement.metricLabel", {
                  label: t("agentManagement.pendingChanges"),
                  count: pendingChangeCount,
                })}
                className="rounded-xl border border-emerald-500/15 bg-white/70 p-3 shadow-sm shadow-emerald-900/[0.03]"
              >
                <p className="text-[10px] text-muted">
                  {t("agentManagement.pendingChanges")}
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-primary">
                  {pendingChangeCount}
                </p>
              </div>
            </div>
            {sameNameSkill && (
              <button
                type="button"
                onClick={() => {
                  openSkillDetailById(sameNameSkill.id);
                  navigate("/my-skills");
                }}
                className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent hover:text-accent-dark"
              >
                {t("agentManagement.viewInLibrary")}
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div className="app-panel flex h-[410px] min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border-faint px-4 pb-2.5 pt-3">
            <h3 className="text-[13px] font-semibold text-primary">
              {t("agentManagement.targetsTitle")}
            </h3>
            <p className="mt-0.5 text-[10px] text-muted">
              {t("agentManagement.targetsDescription")}
            </p>
            <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-2.5 focus-within:border-border">
              <Search className="h-3.5 w-3.5 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("agentManagement.searchPlaceholder", {
                  count: targets.length,
                })}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-secondary outline-none placeholder:text-faint"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("agentManagement.clearSearch")}
                >
                  <X className="h-3 w-3 text-faint" />
                </button>
              )}
            </label>
            <div className="mt-2 flex items-center gap-1 overflow-x-auto scrollbar-hide">
              {([
                ["all", t("agentManagement.filterAll", { count: targets.length })],
                [
                  "deployed",
                  t("agentManagement.filterDeployed", { count: draftTargetKeys.size }),
                ],
                [
                  "available",
                  t("agentManagement.filterAvailable", { count: availableCount }),
                ],
                [
                  "attention",
                  t("agentManagement.filterAttention", { count: attentionCount }),
                ],
              ] as const).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setTargetFilter(key)}
                  className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                    targetFilter === key
                      ? key === "attention" && attentionCount > 0
                        ? "bg-amber-500/10 text-amber-700"
                        : "bg-surface-active text-secondary"
                      : "text-muted hover:bg-surface-hover hover:text-secondary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-border-faint overflow-y-auto overscroll-contain scrollbar-hide">
            {filteredTargets.map((target) => (
              <div key={target.key} className="flex items-center gap-3 px-4 py-2.5">
                <AgentIcon
                  agentKey={target.key}
                  displayName={target.displayName}
                  className="h-7 w-7 rounded-lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold text-secondary">
                    {target.displayName}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-muted">
                    {failedTargetKeys.has(target.key)
                      ? t("agentManagement.failedStatus")
                      : target.active
                        ? target.selected
                          ? t("agentManagement.enabledStatus")
                          : t("agentManagement.disabledStatus")
                        : t("agentManagement.orphanStatus")}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={target.selected}
                  aria-label={t(
                    target.selected
                      ? "agentManagement.disableAgentLabel"
                      : "agentManagement.enableAgentLabel",
                    { name: target.displayName },
                  )}
                  disabled={hasSourceConflict}
                  onClick={() => toggleTarget(target.key)}
                  className={`relative h-6 w-10 rounded-full border transition-colors ${
                    target.selected
                      ? "border-accent bg-accent"
                      : "border-border bg-surface-active"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
                      target.selected ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            ))}
            {filteredTargets.length === 0 && (
              <div className="grid h-full min-h-24 place-items-center px-4 text-center">
                <p className="text-[11px] text-muted">
                  {t("agentManagement.noResults")}
                </p>
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-border-faint bg-bg-secondary p-3 shadow-[0_-8px_18px_rgba(24,24,27,0.03)]">
            {failedOperations.length > 0 && (
              <div className="mb-2.5 flex h-8 items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-2.5">
                <p className="min-w-0 flex-1 truncate text-[10px] font-medium text-amber-700">
                  {t("agentManagement.failureSummary", {
                    names: failedOperations
                      .map((operation) => operation.displayName)
                      .join("、"),
                  })}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void retryFailedOperations()}
                  className="shrink-0 text-[10px] font-semibold text-amber-700 hover:text-amber-800 disabled:opacity-50"
                >
                  {t("agentManagement.retryFailed")}
                </button>
              </div>
            )}
            <div className="mb-2.5 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden text-[11px]">
              {!hasChanges && (
                <span className="text-muted">{t("agentManagement.noChanges")}</span>
              )}
              {visiblePendingOperations.map((operation) => (
                <span
                  key={`${operation.enable ? "add" : "remove"}-${operation.key}`}
                  className={`shrink-0 rounded-full border px-2 py-0.5 font-medium ${
                    operation.enable
                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
                      : "border-amber-500/20 bg-amber-500/10 text-amber-700"
                  }`}
                >
                  {operation.enable ? "+" : "−"} {operation.displayName}
                </span>
              ))}
              {hiddenPendingOperationCount > 0 && (
                <span
                  className="shrink-0 rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-medium text-muted"
                >
                  {t("agentManagement.moreChanges", {
                    count: hiddenPendingOperationCount,
                  })}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!hasChanges || busy}
                onClick={() => setDraftTargetKeys(new Set(targetKeys))}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-secondary disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" />
                {t("agentManagement.discardChanges")}
              </button>
              <button
                type="button"
                disabled={!hasChanges || busy || hasSourceConflict}
                onClick={() => void applyChanges()}
                className="app-button-primary px-3 py-2"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {t("agentManagement.applyChanges")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
