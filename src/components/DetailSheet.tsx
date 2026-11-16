import { useTranslation } from "react-i18next";
import { cn } from "../utils";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { IS_MACOS } from "../lib/platform";

interface DetailSheetProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  workbench?: boolean;
}

export function DetailSheet({
  open,
  title,
  description,
  meta,
  onClose,
  children,
  workbench = false,
}: DetailSheetProps) {
  const { t } = useTranslation();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const rect = sheet.getBoundingClientRect();
      // Leave Escape to any dialog covering the detail sheet.
      const topElement = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!topElement || !sheet.contains(topElement)) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Reserve space for the macOS drag bar.
  return createPortal(
    <div
      ref={sheetRef}
      className={cn("fixed right-0 bottom-0 left-[220px] z-40 isolate", IS_MACOS ? "top-[28px]" : "top-0")}
    >
      <div
        className={
          IS_MACOS
            ? "absolute inset-0 z-0 bg-black/65"
            : "absolute inset-0 z-0 bg-black/60 backdrop-blur-sm"
        }
        onClick={onClose}
      />
      <div className={cn("absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden border-l border-border-subtle", workbench ? "bg-surface" : "bg-bg-secondary")}>
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute top-4 right-5 z-10 shrink-0 rounded-md p-1.5 text-muted transition-colors focus-visible:ring-2 focus-visible:ring-accent hover:bg-surface-hover hover:text-secondary"
        >
          <X className="h-4 w-4" />
        </button>
        <div className={cn("min-h-0 flex-1 scrollbar-hide", workbench ? "flex flex-col" : "overflow-y-auto px-6 pt-5 pb-6")}>
          <div className={workbench ? "shrink-0 px-6 pt-5 pb-3" : undefined}>
            <h2 className={cn("min-w-0 pr-10 font-semibold leading-tight tracking-tight text-primary", workbench ? "mb-2 text-[22px]" : "mb-3 text-[28px]")}>
              <span className="block">{title}</span>
            </h2>
            {description ? (
              <div className="text-[15px] leading-7 text-secondary">{description}</div>
            ) : null}
            {meta ? <div className="mt-4">{meta}</div> : null}
          </div>
          <div className={workbench ? "flex min-h-0 flex-1 flex-col" : "mt-5"}>{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
