import { CheckCircle2, CircleAlert, Clock3, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import type { SkillUpdateBatchProgressStatus } from "../lib/tauri";
import { cn } from "../utils";

export interface SkillUpdateProgressItem {
  id: string;
  name: string;
  sourceType: string;
  status: SkillUpdateBatchProgressStatus;
  lastCheckedAt?: number | null;
  error?: string | null;
  pendingRemovals?: Array<{ location: string; path: string }>;
  removalApproval?: string | null;
}

export type SkillUpdateDialogStage = "checking" | "check_result" | "select" | "updating" | "complete";

interface Props {
  open: boolean;
  stage: SkillUpdateDialogStage;
  items: SkillUpdateProgressItem[];
  skipped: number;
  selectedIds: Set<string>;
  onToggleSelected: (skillId: string) => void;
  onStartUpdate: () => void;
  onSelectAvailable: () => void;
  onConfirmRemoval: (item: SkillUpdateProgressItem) => void;
  onClose: () => void;
}

function statusIcon(status: SkillUpdateBatchProgressStatus) {
  if (status === "checking" || status === "updating") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "error" || status === "source_missing" || status === "needs_confirmation") {
    return <CircleAlert className="h-4 w-4" />;
  }
  if (status === "waiting" || status === "unknown") return <Clock3 className="h-4 w-4" />;
  return <CheckCircle2 className="h-4 w-4" />;
}

export function SkillUpdateProgressDialog({
  open,
  stage,
  items,
  skipped,
  selectedIds,
  onToggleSelected,
  onStartUpdate,
  onSelectAvailable,
  onConfirmRemoval,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const running = stage === "checking" || stage === "updating";
  const { containerRef, onKeyDown } = useModalFocusTrap<HTMLElement>({
    active: open,
    onEscape: running ? undefined : onClose,
  });

  if (!open) return null;

  const completed = items.filter(
    (item) => item.status !== "waiting" && item.status !== "checking" && item.status !== "updating",
  ).length;
  const available = items.filter((item) => item.status === "update_available").length;
  const summary = {
    updated: items.filter((item) => item.status === "updated").length,
    unchanged: items.filter((item) => item.status === "unchanged").length,
    failed: items.filter((item) => item.status === "error").length,
    needsConfirmation: items.filter((item) => item.status === "needs_confirmation").length,
  };
  const progress = items.length === 0 ? 100 : Math.round((completed / items.length) * 100);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-5 backdrop-blur-sm">
      <section
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-update-progress-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[min(720px,calc(100vh-40px))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div>
            <h2 id="skill-update-progress-title" className="text-[15px] font-semibold text-primary">
              {t("mySkills.checkProgress.title")}
            </h2>
            {stage === "select" ? (
              <p className="mt-1 text-[12px] text-muted">
                {t("mySkills.checkProgress.selectTitle")}
              </p>
            ) : stage === "updating" ? (
              <p className="mt-1 text-[12px] text-muted">
                {t("mySkills.checkProgress.updatingTitle")}
              </p>
            ) : stage === "complete" ? (
              <p className="mt-1 text-[12px] text-muted">
                {t("mySkills.checkProgress.completeTitle")}
              </p>
            ) : (
              <p className="mt-1 text-[12px] text-muted">
                {t("mySkills.checkProgress.skipped", { count: skipped })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            aria-label={t("mySkills.checkProgress.close")}
            className="rounded-md p-1 text-muted outline-none transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {stage !== "select" && <div className="border-b border-border-subtle px-5 py-4">
          <div className="mb-2 flex items-center justify-between text-[12px] text-muted">
            <span>{t(stage === "updating" || stage === "complete" ? "mySkills.checkProgress.updateProgress" : "mySkills.checkProgress.progress")}</span>
            <span aria-live="polite">{completed} / {items.length}</span>
          </div>
          <div
            role="progressbar"
            aria-label={t(stage === "updating" || stage === "complete" ? "mySkills.checkProgress.updateProgress" : "mySkills.checkProgress.progress")}
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={completed}
            className="h-2 overflow-hidden rounded-full bg-surface-active"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>}

        <ul
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
          aria-label={t(
            stage === "select"
              ? "mySkills.checkProgress.selectionListLabel"
              : stage === "updating" || stage === "complete"
                ? "mySkills.checkProgress.updateListLabel"
                : "mySkills.checkProgress.listLabel",
          )}
        >
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-lg px-2 py-2.5">
              {stage === "select" ? (
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => onToggleSelected(item.id)}
                  aria-label={t("mySkills.checkProgress.selectItem", { name: item.name })}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              ) : (
                <span
                  className={cn(
                    "shrink-0 text-faint",
                    (item.status === "checking" || item.status === "updating") && "text-accent-light",
                    item.status === "update_available" && "text-amber-500",
                    item.status === "needs_confirmation" && "text-amber-500",
                    (item.status === "error" || item.status === "source_missing") && "text-red-500",
                    (item.status === "up_to_date" || item.status === "updated" || item.status === "unchanged") && "text-emerald-500",
                  )}
                  aria-hidden="true"
                >
                  {statusIcon(item.status)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-secondary" data-testid="check-progress-skill-name">
                  {item.name}
                </p>
                <p className="text-[11px] text-faint">
                  {t(`mySkills.sourceFilter.${item.sourceType}`, { defaultValue: item.sourceType })}
                </p>
                {stage === "select" && (
                  <p className="mt-0.5 text-[11px] text-faint">
                    {item.lastCheckedAt
                      ? t("mySkills.checkProgress.lastChecked", {
                          time: new Date(item.lastCheckedAt).toLocaleString(),
                        })
                      : t("mySkills.checkProgress.neverChecked")}
                  </p>
                )}
                {item.error && (
                  <details className="mt-1 text-[11px] text-red-500/90">
                    <summary className="w-fit cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      {t("mySkills.checkProgress.showError")}
                    </summary>
                    <p className="mt-1 break-words text-muted">{item.error}</p>
                  </details>
                )}
                {stage === "complete" && item.status === "needs_confirmation" && (
                  <button
                    type="button"
                    onClick={() => onConfirmRemoval(item)}
                    aria-label={t("mySkills.checkProgress.confirmItem", { name: item.name })}
                    className="mt-1 rounded text-[11px] font-medium text-amber-600 outline-none hover:text-amber-500 focus-visible:ring-2 focus-visible:ring-accent dark:text-amber-400"
                  >
                    {t("mySkills.checkProgress.confirmIndividually")}
                  </button>
                )}
              </div>
              {stage !== "select" && (
                <span className="shrink-0 text-[12px] text-muted">
                  {t(
                    stage === "updating" || stage === "complete"
                      ? `mySkills.checkProgress.updateStatus.${item.status}`
                      : `mySkills.checkProgress.status.${item.status}`,
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        {stage === "check_result" && (
          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-5 py-4 text-[13px] font-medium text-secondary" aria-live="polite">
            <span>
              {available > 0
                ? t("mySkills.checkProgress.resultAvailable", { count: available })
                : t("mySkills.checkProgress.resultEmpty")}
            </span>
            {available > 0 && (
              <button type="button" onClick={onSelectAvailable} className="app-button-primary">
                {t("mySkills.checkProgress.selectAvailable", { count: available })}
              </button>
            )}
          </div>
        )}
        {stage === "select" && (
          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-5 py-4">
            <span className="text-[12px] text-muted" aria-live="polite">
              {t("mySkills.checkProgress.selectedCount", { count: selectedIds.size })}
            </span>
            <button
              type="button"
              disabled={selectedIds.size === 0}
              onClick={onStartUpdate}
              className="app-button-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("mySkills.checkProgress.startUpdate")}
            </button>
          </div>
        )}
        {stage === "complete" && (
          <div className="border-t border-border-subtle px-5 py-4">
            <p className="text-[13px] font-semibold text-secondary">
              {t("mySkills.checkProgress.completeTitle")}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted" aria-live="polite">
              <span>{t("mySkills.checkProgress.summary.updated", { count: summary.updated })}</span>
              <span>{t("mySkills.checkProgress.summary.unchanged", { count: summary.unchanged })}</span>
              <span>{t("mySkills.checkProgress.summary.failed", { count: summary.failed })}</span>
              <span>{t("mySkills.checkProgress.summary.needsConfirmation", { count: summary.needsConfirmation })}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
