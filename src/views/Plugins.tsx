import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Puzzle, ShieldCheck, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  agentPluginIdentityKey,
  getAgentPluginProjection,
  type AgentPluginCatalogErrorKind,
  type AgentPluginInstallStatus,
  type AgentPluginProjection,
  type AgentPluginSummary,
} from "../lib/agentPlugins";
import { cn } from "../utils";

const ERROR_KEYS: Record<AgentPluginCatalogErrorKind, string> = {
  cli_unavailable: "plugins.errors.cliUnavailable",
  command_unsupported: "plugins.errors.commandUnsupported",
  timed_out: "plugins.errors.timedOut",
  command_failed: "plugins.errors.commandFailed",
  invalid_json: "plugins.errors.invalidJson",
  contract_incompatible: "plugins.errors.contractIncompatible",
  internal: "plugins.errors.internal",
};

function statusKey(status: AgentPluginInstallStatus): string {
  return `plugins.status.${status}`;
}

function StatusBadge({ status }: { status: AgentPluginInstallStatus }) {
  const { t } = useTranslation();
  const enabled = status === "installed_enabled";
  const Icon = enabled ? Check : Unplug;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        enabled
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(statusKey(status))}
    </span>
  );
}

function PluginMark({ name, large = false }: { name: string; large?: boolean }) {
  const text = name.trim().slice(0, 2).toLocaleUpperCase() || "P";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 font-semibold text-accent",
        large ? "h-14 w-14 text-[17px]" : "h-9 w-9 text-[12px]",
      )}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

function PluginDetails({ plugin }: { plugin: AgentPluginSummary }) {
  const { t } = useTranslation();
  const authKey = plugin.auth_policy === "ON_INSTALL"
    ? "plugins.auth.onInstall"
    : plugin.auth_policy === "ON_USE"
      ? "plugins.auth.onUse"
      : plugin.auth_policy === "NONE"
        ? "plugins.auth.none"
        : "plugins.unknown";
  return (
    <aside
      aria-label={t("plugins.detailsLabel")}
      className="min-h-0 bg-background/40"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-start gap-3 border-b border-border-subtle p-5">
          <PluginMark name={plugin.display_name} large />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold tracking-tight text-primary">
                {plugin.display_name}
              </h2>
              <StatusBadge status={plugin.install_status} />
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">
              {plugin.identity.plugin_id}
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-hide">
          <h3 className="mb-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
            {t("plugins.basicDetails")}
          </h3>
          <dl className="grid grid-cols-[112px_1fr] gap-x-4 gap-y-3 text-[12px]">
            <dt className="text-muted">{t("plugins.fields.agent")}</dt>
            <dd className="text-secondary">Codex</dd>
            <dt className="text-muted">{t("plugins.fields.marketplace")}</dt>
            <dd className="break-all font-mono text-[11px] text-secondary">
              {plugin.identity.marketplace_name}
            </dd>
            <dt className="text-muted">{t("plugins.fields.version")}</dt>
            <dd className="font-mono text-[11px] text-secondary">
              {plugin.version ?? t("plugins.unknown")}
            </dd>
            <dt className="text-muted">{t("plugins.fields.status")}</dt>
            <dd className="text-secondary">{t(statusKey(plugin.install_status))}</dd>
            <dt className="text-muted">{t("plugins.fields.auth")}</dt>
            <dd className="text-secondary">{t(authKey)}</dd>
          </dl>
        </div>
      </div>
    </aside>
  );
}

function LoadingPanel() {
  const { t } = useTranslation();
  return (
    <div className="col-span-2 flex min-h-[360px] items-center justify-center">
      <div className="flex items-center gap-2 text-[13px] text-muted" role="status">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t("plugins.loading")}
      </div>
    </div>
  );
}

export function Plugins() {
  const { t } = useTranslation();
  const [projection, setProjection] = useState<AgentPluginProjection | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getAgentPluginProjection("codex")
      .then((next) => {
        if (active) setProjection(next);
      })
      .catch(() => {
        if (active) {
          setProjection({
            read_status: "error",
            agent: "codex",
            refreshed_at_unix_ms: Date.now(),
            error: { kind: "internal" },
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const installed = useMemo(
    () => projection?.read_status === "ready" ? projection.installed : [],
    [projection],
  );
  const selected = useMemo(
    () => installed.find((plugin) => agentPluginIdentityKey(plugin.identity) === selectedKey)
      ?? installed[0]
      ?? null,
    [installed, selectedKey],
  );

  return (
    <div className="flex h-[calc(100vh-68px)] min-h-[560px] flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-primary">
            {t("plugins.title")}
          </h1>
          <p className="mt-1 text-[13px] text-muted">{t("plugins.subtitle")}</p>
        </div>
        <span className="app-badge mt-0.5">
          <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          {t("plugins.readOnly")}
        </span>
      </header>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)] overflow-hidden rounded-xl border border-border-subtle bg-surface">
        {!projection ? (
          <LoadingPanel />
        ) : projection.read_status === "error" ? (
          <div className="col-span-2 flex min-h-[360px] items-center justify-center p-8 text-center">
            <div className="max-w-md">
              <Puzzle className="mx-auto h-8 w-8 text-muted" aria-hidden="true" />
              <h2 className="mt-3 text-[15px] font-semibold text-primary">
                {t("plugins.errors.title")}
              </h2>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                {t(ERROR_KEYS[projection.error.kind])}
              </p>
            </div>
          </div>
        ) : (
          <>
            <section className="flex min-h-0 flex-col border-r border-border-subtle">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3.5">
                <h2 className="text-[13px] font-semibold text-secondary">
                  {t("plugins.installed")}
                </h2>
                <span className="text-[11px] tabular-nums text-muted">
                  {t("plugins.count", { count: installed.length })}
                </span>
              </div>
              {installed.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
                  <Puzzle className="h-8 w-8 text-faint" aria-hidden="true" />
                  <p className="mt-3 text-[13px] font-medium text-tertiary">
                    {t("plugins.emptyTitle")}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {t("plugins.emptyDescription")}
                  </p>
                </div>
              ) : (
                <div
                  role="listbox"
                  aria-label={t("plugins.listLabel")}
                  className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-hide"
                >
                  {installed.map((plugin) => {
                    const key = agentPluginIdentityKey(plugin.identity);
                    const active = selected
                      ? agentPluginIdentityKey(selected.identity) === key
                      : false;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={active}
                        aria-label={`${plugin.display_name} · ${plugin.identity.marketplace_name} · ${plugin.identity.plugin_id}`}
                        onClick={() => setSelectedKey(key)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-accent/50",
                          active ? "bg-surface-active" : "hover:bg-surface-hover",
                        )}
                      >
                        <PluginMark name={plugin.display_name} />
                        <span className="min-w-0 flex-1">
                          <span className={cn(
                            "block truncate text-[13px] font-medium",
                            active ? "text-primary" : "text-secondary",
                          )}>
                            {plugin.display_name}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-faint">
                            {plugin.identity.marketplace_name} · {plugin.version ?? t("plugins.unknown")}
                          </span>
                        </span>
                        <StatusBadge status={plugin.install_status} />
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
            {selected ? (
              <PluginDetails plugin={selected} />
            ) : (
              <aside
                aria-label={t("plugins.detailsLabel")}
                className="flex min-h-0 items-center justify-center bg-background/40 p-8 text-[13px] text-muted"
              >
                {t("plugins.noSelection")}
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  );
}
