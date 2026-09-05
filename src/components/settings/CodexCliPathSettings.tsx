import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileSearch, Loader2, RotateCcw, Terminal } from "lucide-react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  getCodexCliConfiguration,
  resetCodexCliPath,
  setCodexCliPath,
  validateCodexCliPath,
  type CodexCliConfiguration,
  type CodexCliFactStatus,
} from "../../lib/agentPlugins";
import { agentPluginErrorMessageKey } from "../../lib/agentPluginErrors";
import { cn } from "../../utils";

type Completion = "none" | "validated" | "saved" | "reset";
type PendingAction = "loading" | "validating" | "saving" | "resetting" | null;

function FactRow({
  label,
  status,
}: {
  label: string;
  status: CodexCliFactStatus;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className={cn(
        "font-medium",
        status === "confirmed"
          ? "text-emerald-600 dark:text-emerald-300"
          : status === "unavailable"
            ? "text-amber-700 dark:text-amber-300"
            : "text-faint",
      )}>
        {t(`settings.codexCli.factStatus.${status}`)}
      </span>
    </div>
  );
}

export function CodexCliPathSettings() {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement>(null);
  const [configuration, setConfiguration] = useState<CodexCliConfiguration | null>(null);
  const [savedConfiguration, setSavedConfiguration] =
    useState<CodexCliConfiguration | null>(null);
  const [path, setPath] = useState("");
  const [completion, setCompletion] = useState<Completion>("none");
  const [pending, setPending] = useState<PendingAction>("loading");

  useEffect(() => {
    let active = true;
    getCodexCliConfiguration()
      .then((next) => {
        if (!active) return;
        setConfiguration(next);
        setSavedConfiguration(next);
        setPath(next.configured_path ?? "");
      })
      .catch(() => {
        if (!active) return;
        const unavailable: CodexCliConfiguration = {
          resolution_source: "environment",
          configured_path: null,
          facts: {
            configuration_directory: "unchecked",
            executable_resolution: "unchecked",
            command_runtime: "unchecked",
            plugin_json_contract: "unchecked",
          },
          error: "internal",
        };
        setConfiguration(unavailable);
        setSavedConfiguration(unavailable);
      })
      .finally(() => {
        if (active) setPending(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const targeted = new URLSearchParams(window.location.search).get("section") === "codex-cli"
      || window.location.hash === "#codex-cli-settings";
    if (targeted) {
      sectionRef.current?.scrollIntoView({ block: "center" });
      sectionRef.current?.focus();
    }
  }, []);

  const runAction = async (
    action: Exclude<PendingAction, "loading" | null>,
    operation: () => Promise<CodexCliConfiguration>,
    nextCompletion: Completion,
  ) => {
    setPending(action);
    setCompletion("none");
    try {
      const next = await operation();
      setConfiguration(next);
      if (!next.error) setCompletion(nextCompletion);
      if (!next.error && (action === "saving" || action === "resetting")) {
        setSavedConfiguration(next);
      }
      if (action === "resetting") setPath(next.configured_path ?? "");
    } catch {
      setConfiguration((current) => current ? { ...current, error: "internal" } : null);
    } finally {
      setPending(null);
    }
  };

  const selectExecutable = async () => {
    const selected = await dialogOpen({ directory: false, multiple: false });
    if (typeof selected === "string") {
      setPath(selected);
      setConfiguration(savedConfiguration);
      setCompletion("none");
    }
  };

  const message = configuration?.error
    ? t(agentPluginErrorMessageKey("settings.codexCli", configuration.error))
    : completion === "validated"
      ? t("settings.codexCli.validationSuccess")
      : completion === "saved"
        ? t("settings.codexCli.saved")
        : configuration?.resolution_source === "explicit"
          ? t("settings.codexCli.explicitActive")
          : t("settings.codexCli.environmentActive");
  const fieldClass = "h-9 rounded-lg border border-border-subtle bg-background px-3 text-[13px] text-secondary outline-none focus:border-border";
  const actionButtonClass = "app-button-secondary h-9 gap-1.5 px-3";

  return (
    <section
      ref={sectionRef}
      id="codex-cli-settings"
      tabIndex={-1}
      className="space-y-3 outline-none focus:ring-2 focus:ring-accent/50"
      aria-labelledby="codex-cli-title"
      aria-busy={pending !== null}
    >
      <div>
        <h2 id="codex-cli-title" className="app-section-title flex items-center gap-2">
          <Terminal className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("settings.codexCli.title")}
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          {t("settings.codexCli.description")}
        </p>
      </div>

      <div className="app-panel space-y-4 p-4">
        <div>
          <label htmlFor="codex-cli-path" className="mb-1 block text-[12px] text-muted">
            {t("settings.codexCli.inputLabel")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="codex-cli-path"
              type="text"
              value={path}
              disabled={pending !== null}
              onChange={(event) => {
                setPath(event.target.value);
                setConfiguration(savedConfiguration);
                setCompletion("none");
              }}
              placeholder={t("settings.codexCli.placeholder")}
              className={`${fieldClass} min-w-[280px] flex-1 font-mono disabled:cursor-not-allowed disabled:opacity-60`}
            />
            <button
              type="button"
              onClick={() => void selectExecutable()}
              disabled={pending !== null}
              className={actionButtonClass}
            >
              <FileSearch className="h-3.5 w-3.5" aria-hidden="true" />
              {t("settings.codexCli.select")}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void runAction(
              "validating",
              () => validateCodexCliPath(path.trim()),
              "validated",
            )}
            disabled={pending !== null || !path.trim()}
            className={actionButtonClass}
          >
            {pending === "validating" ? (
              <span className="animate-spin" aria-hidden="true">
                <Loader2 className="h-3.5 w-3.5" />
              </span>
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t("settings.codexCli.validate")}
          </button>
          <button
            type="button"
            onClick={() => void runAction(
              "saving",
              () => setCodexCliPath(path.trim()),
              "saved",
            )}
            disabled={pending !== null || !path.trim()}
            className={actionButtonClass}
          >
            {pending === "saving" ? (
              <span className="animate-spin" aria-hidden="true">
                <Loader2 className="h-3.5 w-3.5" />
              </span>
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t("settings.codexCli.save")}
          </button>
          <button
            type="button"
            onClick={() => void runAction(
              "resetting",
              resetCodexCliPath,
              "reset",
            )}
            disabled={pending !== null}
            className={actionButtonClass}
          >
            {pending === "resetting" ? (
              <span className="animate-spin" aria-hidden="true">
                <Loader2 className="h-3.5 w-3.5" />
              </span>
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t("settings.codexCli.reset")}
          </button>
        </div>

        {pending === "loading" ? (
          <p className="text-[12px] text-muted" role="status">
            {t("settings.codexCli.loading")}
          </p>
        ) : configuration && (
          <>
            <p
              className={cn(
                "rounded-lg border px-3 py-2 text-[12px] leading-5",
                configuration.error
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                  : "border-emerald-500/20 bg-emerald-500/8 text-emerald-800 dark:text-emerald-200",
              )}
              role={configuration.error ? "alert" : "status"}
            >
              {message}
            </p>
            <div className="grid gap-2 rounded-lg border border-border-subtle bg-background p-3 sm:grid-cols-2">
              <FactRow
                label={t("settings.codexCli.facts.configurationDirectory")}
                status={configuration.facts.configuration_directory}
              />
              <FactRow
                label={t("settings.codexCli.facts.executableResolution")}
                status={configuration.facts.executable_resolution}
              />
              <FactRow
                label={t("settings.codexCli.facts.commandRuntime")}
                status={configuration.facts.command_runtime}
              />
              <FactRow
                label={t("settings.codexCli.facts.pluginJsonContract")}
                status={configuration.facts.plugin_json_contract}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
