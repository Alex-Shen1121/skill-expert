import { listen } from "@tauri-apps/api/event";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ConfirmDialogProps } from "../components/ConfirmDialog";
import type {
  SkillUpdateProgressDialogProps,
  SkillUpdateProgressItem,
  SkillUpdateDialogStage,
} from "../components/SkillUpdateProgressDialog";
import { getErrorMessage } from "../lib/error";
import {
  hasAvailableUpdate,
  refreshManagedSkill,
  type SkillRefreshOutcome,
} from "../lib/skillUpdate";
import * as api from "../lib/tauri";
import type { ManagedSkill } from "../lib/tauri";

type SkillUpdateBatchState = {
  batchId: string;
  operation: "check" | "update";
  stage: SkillUpdateDialogStage;
  stopRequested: boolean;
  items: SkillUpdateProgressItem[];
  skipped: number;
  selectedIds: Set<string>;
};

type SkillUpdateBatchRemovalOutcome = SkillRefreshOutcome | { status: "error"; error: string };

type UseSkillUpdateBatchOptions = {
  skills: ManagedSkill[];
  displayNames: ReadonlyMap<string, string>;
  refreshManagedSkills: () => Promise<unknown>;
};

type UseSkillUpdateBatchResult = {
  checking: boolean;
  updating: boolean;
  checkAll: () => Promise<void>;
  openAvailableUpdates: () => void;
  dialogProps: SkillUpdateProgressDialogProps;
  removalDialogProps: ConfirmDialogProps;
};

const skillNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function createBatchId(prefix: string) {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sortByDisplayName(
  skills: ManagedSkill[],
  displayNames: ReadonlyMap<string, string>,
) {
  return [...skills].sort((left, right) => {
    const compared = skillNameCollator.compare(
      displayNames.get(left.id) || left.name,
      displayNames.get(right.id) || right.name,
    );
    return compared !== 0 ? compared : left.id.localeCompare(right.id);
  });
}

/**
 * 隐藏前台 Skill 检查与更新的状态机、事件归并和恢复控制。
 * 页面只负责提供中央技能库快照、显示名和刷新动作。
 */
export function useSkillUpdateBatch({
  skills,
  displayNames,
  refreshManagedSkills,
}: UseSkillUpdateBatchOptions): UseSkillUpdateBatchResult {
  const { t } = useTranslation();
  const [state, setState] = useState<SkillUpdateBatchState | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [removalItem, setRemovalItem] = useState<SkillUpdateProgressItem | null>(null);

  const listenToProgress = useCallback((
    batchId: string,
    operation: "check" | "update",
  ) => listen<api.SkillUpdateBatchProgress>(
    "skill-update-batch-progress",
    ({ payload }) => {
      setState((current) => {
        if (
          !current
          || current.batchId !== batchId
          || payload.batch_id !== batchId
          || payload.phase !== operation
        ) {
          return current;
        }
        return {
          ...current,
          items: current.items.map((item) => item.id === payload.skill_id
            ? { ...item, status: payload.status, error: payload.error }
            : item),
        };
      });
    },
  ), []);

  const runUpdates = useCallback(async (
    batchId: string,
    selectedItems: SkillUpdateProgressItem[],
  ) => {
    const selectedIds = selectedItems.map((item) => item.id);
    if (selectedIds.length === 0) return;

    setState({
      batchId,
      operation: "update",
      stage: "updating",
      stopRequested: false,
      skipped: 0,
      selectedIds: new Set(selectedIds),
      items: selectedItems.map((item) => ({ ...item, status: "waiting", error: null })),
    });
    setUpdating(true);
    let unlisten: (() => void) | null = null;
    let stopped = false;
    try {
      unlisten = await listenToProgress(batchId, "update");
      const result = await api.batchUpdateSkills(selectedIds, batchId);
      stopped = result.stopped;
      if (result.batch_id === batchId) {
        const resultsById = new Map(result.items.map((item) => [item.skill_id, item]));
        setState((current) => current?.batchId === batchId
          ? {
              ...current,
              items: current.items.map((item) => {
                const updated = resultsById.get(item.id);
                return updated
                  ? {
                      ...item,
                      sourceType: updated.source_type,
                      status: updated.status,
                      error: updated.error,
                      pendingRemovals: updated.pending_removals,
                      removalApproval: updated.removal_approval,
                    }
                  : item;
              }),
            }
          : current);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("common.error"));
      setState((current) => current?.batchId === batchId
        ? {
            ...current,
            items: current.items.map((item) =>
              item.status === "waiting" || item.status === "updating"
                ? { ...item, status: "error", error: message }
                : item,
            ),
          }
        : current);
      toast.error(message);
    } finally {
      unlisten?.();
      await refreshManagedSkills();
      setUpdating(false);
      setState((current) => current?.batchId === batchId
        ? { ...current, stage: stopped ? "stopped" : "complete", stopRequested: false }
        : current);
    }
  }, [listenToProgress, refreshManagedSkills, t]);

  const runChecks = useCallback(async (
    batchId: string,
    checkItems: SkillUpdateProgressItem[],
    skipped: number,
    requestedSkillIds?: string[],
  ) => {
    setState({
      batchId,
      operation: "check",
      stage: "checking",
      stopRequested: false,
      items: checkItems.map((item) => ({ ...item, status: "waiting", error: null })),
      skipped,
      selectedIds: new Set(),
    });
    setChecking(true);
    let unlisten: (() => void) | null = null;
    let stopped = false;
    try {
      unlisten = await listenToProgress(batchId, "check");
      const result = requestedSkillIds
        ? await api.retryFailedSkillUpdateChecks(requestedSkillIds, batchId)
        : await api.checkAllSkillUpdates(true, batchId);
      stopped = result.stopped;
      if (result.batch_id === batchId) {
        setState((current) => {
          if (!current || current.batchId !== batchId) return current;
          const resultsById = new Map(result.items.map((item) => [item.skill_id, item]));
          const existingIds = new Set(current.items.map((item) => item.id));
          const updatedItems = current.items
            .filter((item) => resultsById.has(item.id))
            .map((item) => {
              const checked = resultsById.get(item.id)!;
              return {
                ...item,
                sourceType: checked.source_type,
                status: checked.status,
                error: checked.error,
                lastCheckedAt: checked.last_checked_at,
              };
            });
          for (const checked of result.items) {
            if (existingIds.has(checked.skill_id)) continue;
            updatedItems.push({
              id: checked.skill_id,
              name: checked.name,
              sourceType: checked.source_type,
              status: checked.status,
              error: checked.error,
              lastCheckedAt: checked.last_checked_at,
            });
          }
          return {
            ...current,
            skipped: result.skipped,
            items: updatedItems,
          };
        });
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("common.error"));
      setState((current) => current?.batchId === batchId
        ? {
            ...current,
            items: current.items.map((item) =>
              item.status === "waiting" || item.status === "checking"
                ? { ...item, status: "error", error: message }
                : item,
            ),
          }
        : current);
      toast.error(message);
    } finally {
      unlisten?.();
      await refreshManagedSkills();
      setChecking(false);
      setState((current) => current?.batchId === batchId
        ? { ...current, stage: stopped ? "stopped" : "check_result", stopRequested: false }
        : current);
    }
  }, [listenToProgress, refreshManagedSkills, t]);

  const checkAll = useCallback(async () => {
    const checkable = sortByDisplayName(
      skills.filter((skill) => skill.can_check_update),
      displayNames,
    );
    await runChecks(
      createBatchId("check"),
      checkable.map((skill) => ({
        id: skill.id,
        name: displayNames.get(skill.id) || skill.name,
        sourceType: skill.source_type,
        status: "waiting",
      })),
      skills.length - checkable.length,
    );
  }, [displayNames, runChecks, skills]);

  const openAvailableUpdates = useCallback(() => {
    const updatable = sortByDisplayName(
      skills.filter(hasAvailableUpdate),
      displayNames,
    );
    if (updatable.length === 0) return;
    setState({
      batchId: createBatchId("update"),
      operation: "update",
      stage: "select",
      stopRequested: false,
      skipped: 0,
      selectedIds: new Set(updatable.map((skill) => skill.id)),
      items: updatable.map((skill) => ({
        id: skill.id,
        name: displayNames.get(skill.id) || skill.name,
        sourceType: skill.source_type,
        status: "update_available",
        lastCheckedAt: skill.last_checked_at,
      })),
    });
  }, [displayNames, skills]);

  const toggleSelected = useCallback((skillId: string) => {
    setState((current) => {
      if (!current || current.stage !== "select") return current;
      const selectedIds = new Set(current.selectedIds);
      if (selectedIds.has(skillId)) selectedIds.delete(skillId);
      else selectedIds.add(skillId);
      return { ...current, selectedIds };
    });
  }, []);

  const startSelectedUpdates = useCallback(async () => {
    if (!state || state.stage !== "select") return;
    await runUpdates(
      state.batchId,
      state.items.filter((item) => state.selectedIds.has(item.id)),
    );
  }, [runUpdates, state]);

  const selectAvailable = useCallback(() => {
    setState((current) => {
      if (!current || current.stage !== "check_result") return current;
      const items = current.items.filter((item) => item.status === "update_available");
      return {
        ...current,
        stage: "select",
        items,
        selectedIds: new Set(items.map((item) => item.id)),
      };
    });
  }, []);

  const stop = useCallback(async () => {
    const current = state;
    if (
      !current
      || current.stopRequested
      || (current.stage !== "checking" && current.stage !== "updating")
    ) {
      return;
    }
    setState((value) => value?.batchId === current.batchId
      ? { ...value, stopRequested: true }
      : value);
    try {
      const accepted = await api.stopSkillUpdateBatch(current.batchId);
      if (!accepted) {
        setState((value) => value?.batchId === current.batchId
          ? { ...value, stopRequested: false }
          : value);
      }
    } catch (error: unknown) {
      setState((value) => value?.batchId === current.batchId
        ? { ...value, stopRequested: false }
        : value);
      toast.error(getErrorMessage(error, t("common.error")));
    }
  }, [state, t]);

  const retryFailures = useCallback(async () => {
    const current = state;
    if (!current || current.stage === "checking" || current.stage === "updating") return;
    const failedItems = current.items.filter((item) => item.status === "error");
    if (failedItems.length === 0) return;
    const batchId = createBatchId("retry");
    if (current.operation === "check") {
      await runChecks(batchId, failedItems, 0, failedItems.map((item) => item.id));
    } else {
      await runUpdates(batchId, failedItems);
    }
  }, [runChecks, runUpdates, state]);

  const resolveRemoval = useCallback((
    skillId: string,
    outcome: SkillUpdateBatchRemovalOutcome,
  ) => {
    setState((current) => current
      ? {
          ...current,
          items: current.items.map((item) => item.id === skillId
            ? {
                ...item,
                status: outcome.status,
                error: outcome.status === "error" ? outcome.error : null,
                pendingRemovals: outcome.status === "needs_confirmation"
                  ? outcome.pendingRemovals
                  : [],
                removalApproval: outcome.status === "needs_confirmation"
                  ? outcome.removalApproval
                  : null,
              }
            : item),
        }
      : current);
  }, []);

  const confirmRemoval = useCallback(async () => {
    const item = removalItem;
    if (!item) return;
    const skill = skills.find((candidate) => candidate.id === item.id);
    if (!skill) {
      const message = t("common.error");
      resolveRemoval(item.id, { status: "error", error: message });
      setRemovalItem(null);
      toast.error(message);
      return;
    }

    setUpdating(true);
    try {
      const outcome = await refreshManagedSkill(skill, item.removalApproval ?? undefined);
      if (skill.source_type === "local" || skill.source_type === "import") {
        if (outcome.status === "updated") toast.success(t("mySkills.updateActions.reimported"));
      } else if (outcome.status === "updated") {
        toast.success(t("mySkills.updateActions.updated"));
      } else if (outcome.status === "unchanged") {
        toast.info(t("mySkills.updateActions.alreadyUpToDate"));
      }
      resolveRemoval(item.id, outcome);
    } catch (error: unknown) {
      const message = getErrorMessage(error, t("common.error"));
      resolveRemoval(item.id, { status: "error", error: message });
      toast.error(message);
    } finally {
      setRemovalItem(null);
      await refreshManagedSkills();
      setUpdating(false);
    }
  }, [refreshManagedSkills, removalItem, resolveRemoval, skills, t]);

  return {
    checking,
    updating,
    checkAll,
    openAvailableUpdates,
    dialogProps: {
      open: state !== null && removalItem === null,
      stage: state?.stage ?? "checking",
      items: state?.items ?? [],
      skipped: state?.skipped ?? 0,
      selectedIds: state?.selectedIds ?? new Set(),
      operation: state?.operation ?? "check",
      stopRequested: state?.stopRequested ?? false,
      onToggleSelected: toggleSelected,
      onStartUpdate: startSelectedUpdates,
      onSelectAvailable: selectAvailable,
      onConfirmRemoval: setRemovalItem,
      onStop: stop,
      onRetryFailures: retryFailures,
      onClose: () => setState(null),
    },
    removalDialogProps: {
      open: removalItem !== null,
      tone: "warning",
      title: t("mySkills.updateActions.removalTitle"),
      message: t("mySkills.updateActions.removalMessage", {
        name: removalItem?.name ?? "",
        count: removalItem?.pendingRemovals?.length ?? 0,
      }),
      details: removalItem?.pendingRemovals?.map((removal) =>
        removal.location === "library"
          ? removal.path
          : `${removal.location}: ${removal.path}`
      ),
      confirmLabel: t("mySkills.updateActions.removalConfirm"),
      onClose: () => setRemovalItem(null),
      onConfirm: confirmRemoval,
    },
  };
}
