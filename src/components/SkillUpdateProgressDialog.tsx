import { CheckCircle2, CircleAlert, Clock3, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import type { SkillUpdateBatchProgressStatus } from "../lib/tauri";
import { cn } from "../utils";

export interface SkillCheckProgressItem {
  id: string;
  name: string;
  sourceType: string;
  status: SkillUpdateBatchProgressStatus;
  error?: string | null;
}

interface Props {
  open: boolean;
  running: boolean;
  items: SkillCheckProgressItem[];
  skipped: number;
  onClose: () => void;
}

function statusIcon(status: SkillUpdateBatchProgressStatus) {
  if (status === "checking") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "error" || status === "source_missing") {
    return <CircleAlert className="h-4 w-4" />;
  }
  if (status === "waiting" || status === "unknown") return <Clock3 className="h-4 w-4" />;
  return <CheckCircle2 className="h-4 w-4" />;
}

export function SkillUpdateProgressDialog({ open, running, items, skipped, onClose }: Props) {
  const { t } = useTranslation();
  const { containerRef, onKeyDown } = useModalFocusTrap<HTMLElement>({
    active: open,
    onEscape: running ? undefined : onClose,
  });

  if (!open) return null;

  const completed = items.filter(
    (item) => item.status !== "waiting" && item.status !== "checking",
  ).length;
  const available = items.filter((item) => item.status === "update_available").length;
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
            <p className="mt-1 text-[12px] text-muted">
              {t("mySkills.checkProgress.skipped", { count: skipped })}
            </p>
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

        <div className="border-b border-border-subtle px-5 py-4">
          <div className="mb-2 flex items-center justify-between text-[12px] text-muted">
            <span>{t("mySkills.checkProgress.progress")}</span>
            <span aria-live="polite">{completed} / {items.length}</span>
          </div>
          <div
            role="progressbar"
            aria-label={t("mySkills.checkProgress.progress")}
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
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label={t("mySkills.checkProgress.listLabel")}>
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-lg px-2 py-2.5">
              <span
                className={cn(
                  "shrink-0 text-faint",
                  item.status === "checking" && "text-accent-light",
                  item.status === "update_available" && "text-amber-500",
                  (item.status === "error" || item.status === "source_missing") && "text-red-500",
                  item.status === "up_to_date" && "text-emerald-500",
                )}
                aria-hidden="true"
              >
                {statusIcon(item.status)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-secondary" data-testid="check-progress-skill-name">
                  {item.name}
                </p>
                <p className="text-[11px] text-faint">
                  {t(`mySkills.sourceFilter.${item.sourceType}`, { defaultValue: item.sourceType })}
                </p>
                {item.error && (
                  <details className="mt-1 text-[11px] text-red-500/90">
                    <summary className="w-fit cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      {t("mySkills.checkProgress.showError")}
                    </summary>
                    <p className="mt-1 break-words text-muted">{item.error}</p>
                  </details>
                )}
              </div>
              <span className="shrink-0 text-[12px] text-muted">
                {t(`mySkills.checkProgress.status.${item.status}`)}
              </span>
            </li>
          ))}
        </ul>
        {!running && (
          <div className="border-t border-border-subtle px-5 py-4 text-[13px] font-medium text-secondary" aria-live="polite">
            {available > 0
              ? t("mySkills.checkProgress.resultAvailable", { count: available })
              : t("mySkills.checkProgress.resultEmpty")}
          </div>
        )}
      </section>
    </div>
  );
}
