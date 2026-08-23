import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { DatabaseBackup } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../lib/error";
import * as api from "../lib/tauri";
import type { ExistingInstallationImportStatus } from "../lib/tauri";

export type { ExistingInstallationImportStatus } from "../lib/tauri";

export interface ExistingInstallationImportService {
  getStatus: () => Promise<ExistingInstallationImportStatus>;
  choose: (
    choice: "import" | "fresh",
    confirmedSource?: string | null,
  ) => Promise<void>;
  restart: () => Promise<void>;
}

interface ExistingInstallationImportDialogProps {
  status: ExistingInstallationImportStatus;
  service?: ExistingInstallationImportService;
  onResolved: (status: ExistingInstallationImportStatus) => void;
}

const defaultService: ExistingInstallationImportService = {
  getStatus: api.getExistingInstallationImportStatus,
  choose: api.chooseExistingInstallationImport,
  restart: api.restartApp,
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function StartupModalPanel({
  labelledBy,
  children,
}: {
  labelledBy: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  const focusableElements = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = focusableElements()[0];
    (first ?? panelRef.current)?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        {children}
      </div>
    </div>
  );
}

export function ExistingInstallationImportDialog({
  status,
  service = defaultService,
  onResolved,
}: ExistingInstallationImportDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayedError = error ?? status.error;

  const startFresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await service.choose("fresh");
      onResolved({
        state: "fresh",
        should_prompt: false,
        source_path: null,
        backup_path: null,
        error: null,
      });
    } catch (err) {
      setError(getErrorMessage(err, t("common.error")));
      setBusy(false);
    }
  };

  const importExisting = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await service.choose("import", status.source_path);
      await service.restart();
    } catch (err) {
      setError(getErrorMessage(err, t("common.error")));
      setBusy(false);
    }
  };

  return (
    <StartupModalPanel labelledBy="existing-installation-import-title">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-bg-secondary">
            <DatabaseBackup className="h-5 w-5 text-muted" />
          </div>
          <div className="min-w-0">
            <h2 id="existing-installation-import-title" className="text-[15px] font-semibold text-primary">
              {t("existingInstallImport.title")}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              {t("existingInstallImport.subtitle")}
            </p>
          </div>
        </div>

        <p className="mt-3 truncate rounded-md border border-border-subtle bg-background px-3 py-2 font-mono text-[12px] text-tertiary">
          {status.source_path}
        </p>

        <p className="mt-3 text-[12px] leading-5 text-faint">
          {t("existingInstallImport.safety")}
        </p>

        {displayedError && (
          <p role="alert" className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-300">
            {displayedError}
          </p>
        )}

        {status.backup_path && (
          <div className="mt-3 text-[12px] leading-5 text-tertiary">
            <span>{t("existingInstallImport.backupPath")}</span>
            <p className="truncate font-mono text-faint">{status.backup_path}</p>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={startFresh}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-tertiary disabled:opacity-50"
          >
            {t("existingInstallImport.startFresh")}
          </button>
          <button
            type="button"
            onClick={importExisting}
            disabled={busy}
            className="rounded-lg border border-accent-border bg-accent-dark px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {t("existingInstallImport.import")}
          </button>
        </div>
    </StartupModalPanel>
  );
}

interface ExistingInstallationImportGateProps {
  service?: ExistingInstallationImportService;
  children?: ReactNode;
}

/**
 * Owns the single startup decision gate. The backup-restore prompt is not
 * mounted until the existing-installation state has loaded successfully and
 * no import prompt or pending restart needs to take precedence.
 */
export function ExistingInstallationImportGate({
  service = defaultService,
  children,
}: ExistingInstallationImportGateProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ExistingInstallationImportStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    let active = true;
    void service.getStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (error: unknown) => {
        if (active) setLoadError(getErrorMessage(error, t("common.error")));
      },
    );
    return () => {
      active = false;
    };
  }, [requestId, service, t]);

  if (loadError) {
    return (
      <StartupModalPanel labelledBy="existing-installation-import-load-error-title">
          <h2
            id="existing-installation-import-load-error-title"
            className="text-[15px] font-semibold text-primary"
          >
            {t("existingInstallImport.loadErrorTitle")}
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-muted">
            {t("existingInstallImport.loadErrorSubtitle")}
          </p>
          <p
            role="alert"
            className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-300"
          >
            {loadError}
          </p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setStatus(null);
                setRequestId((value) => value + 1);
              }}
              className="rounded-lg border border-accent-border bg-accent-dark px-3 py-1.5 text-[13px] font-medium text-white"
            >
              {t("common.retry")}
            </button>
          </div>
      </StartupModalPanel>
    );
  }

  if (!status) return null;
  if (status.should_prompt) {
    return (
      <ExistingInstallationImportDialog
        status={status}
        service={service}
        onResolved={setStatus}
      />
    );
  }
  if (status.state === "pending") return null;
  return <>{children}</>;
}
