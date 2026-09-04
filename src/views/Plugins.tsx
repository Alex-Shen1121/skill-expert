import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { PluginCatalogControls } from "../components/plugins/PluginCatalogControls";
import {
  PluginCatalogEmptyState,
  PluginList,
} from "../components/plugins/PluginList";
import {
  agentPluginIdentityKey,
  getAgentPluginProjection,
  type AgentPluginCatalogErrorKind,
  type AgentPluginInstallStatus,
  type AgentPluginProjection,
  type AgentPluginSummary,
} from "../lib/agentPlugins";
import {
  getAgentPluginMarketplaces,
  getAgentPluginScopeCounts,
  getMigratedAgentPluginSelection,
  getVisibleAgentPlugins,
  type AgentPluginScope,
} from "../lib/agentPluginView";
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
  const appearance = status === "installed_enabled"
    ? {
        Icon: Check,
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      }
    : status === "installed_disabled"
      ? {
          Icon: Unplug,
          className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        }
      : {
          Icon: Download,
          className: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        };
  const { Icon } = appearance;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        appearance.className,
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
        <span className="animate-spin" aria-hidden="true">
          <LoaderCircle className="h-4 w-4" />
        </span>
        {t("plugins.loading")}
      </div>
    </div>
  );
}

export function Plugins() {
  const { t, i18n } = useTranslation();
  const [projection, setProjection] = useState<AgentPluginProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<AgentPluginScope>("installed");
  const [query, setQuery] = useState("");
  const [marketplace, setMarketplace] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const commitProjectionRequest = useCallback((
    requestId: number,
    request: Promise<AgentPluginProjection>,
  ) => {
    void request
      .catch((): AgentPluginProjection => ({
        read_status: "error",
        agent: "codex",
        refreshed_at_unix_ms: Date.now(),
        error: { kind: "internal" },
      }))
      .then((next) => {
        if (requestSequence.current === requestId) {
          setProjection(next);
          setLoading(false);
        }
      });
  }, []);

  const loadProjection = useCallback(() => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setLoading(true);
    commitProjectionRequest(requestId, getAgentPluginProjection("codex"));
  }, [commitProjectionRequest]);

  useEffect(() => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    commitProjectionRequest(requestId, getAgentPluginProjection("codex"));
    return () => {
      requestSequence.current += 1;
    };
  }, [commitProjectionRequest]);

  const readyProjection = projection?.read_status === "ready" ? projection : null;
  const counts = useMemo(
    () => readyProjection
      ? getAgentPluginScopeCounts(readyProjection)
      : { installed: 0, available: 0 },
    [readyProjection],
  );
  const marketplaces = useMemo(
    () => readyProjection
      ? getAgentPluginMarketplaces(readyProjection, i18n.resolvedLanguage ?? i18n.language)
      : [],
    [i18n.language, i18n.resolvedLanguage, readyProjection],
  );
  const visiblePlugins = useMemo(
    () => readyProjection
      ? getVisibleAgentPlugins({
          projection: readyProjection,
          scope,
          query,
          marketplace,
          language: i18n.resolvedLanguage ?? i18n.language,
        })
      : [],
    [i18n.language, i18n.resolvedLanguage, marketplace, query, readyProjection, scope],
  );
  const migratedSelectedKey = useMemo(
    () => getMigratedAgentPluginSelection(visiblePlugins, selectedKey),
    [selectedKey, visiblePlugins],
  );
  const selected = useMemo(
    () => visiblePlugins.find(
      (plugin) => agentPluginIdentityKey(plugin.identity) === migratedSelectedKey,
    ) ?? null,
    [migratedSelectedKey, visiblePlugins],
  );

  const updateFilters = useCallback((next: {
    scope?: AgentPluginScope;
    query?: string;
    marketplace?: string;
  }) => {
    const nextScope = next.scope ?? scope;
    const nextQuery = next.query ?? query;
    const nextMarketplace = next.marketplace ?? marketplace;
    if (readyProjection) {
      const nextVisiblePlugins = getVisibleAgentPlugins({
        projection: readyProjection,
        scope: nextScope,
        query: nextQuery,
        marketplace: nextMarketplace,
        language: i18n.resolvedLanguage ?? i18n.language,
      });
      setSelectedKey(getMigratedAgentPluginSelection(
        nextVisiblePlugins,
        migratedSelectedKey,
      ));
    }
    if (next.scope !== undefined) setScope(next.scope);
    if (next.query !== undefined) setQuery(next.query);
    if (next.marketplace !== undefined) setMarketplace(next.marketplace);
  }, [
    i18n.language,
    i18n.resolvedLanguage,
    marketplace,
    migratedSelectedKey,
    query,
    readyProjection,
    scope,
  ]);

  const scopeTotal = counts[scope];
  const emptyTitle = scopeTotal === 0
    ? t(scope === "installed" ? "plugins.emptyTitle" : "plugins.emptyAvailableTitle")
    : t("plugins.noMatchesTitle");
  const emptyDescription = scopeTotal === 0
    ? t("plugins.emptyDescription")
    : t("plugins.noMatchesDescription");
  const listLabel = t(
    scope === "installed" ? "plugins.listLabel" : "plugins.availableListLabel",
  );

  return (
    <div
      className="flex h-[calc(100vh-68px)] min-h-[560px] flex-col"
      aria-busy={loading}
    >
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-primary">
            {t("plugins.title")}
          </h1>
          <p className="mt-1 text-[13px] text-muted">{t("plugins.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {loading && projection && (
            <span
              className="text-[12px] text-muted"
              role="status"
              aria-live="polite"
            >
              {t("plugins.refreshing")}
            </span>
          )}
          <span className="app-badge">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            {t("plugins.readOnly")}
          </span>
          <button
            type="button"
            onClick={loadProjection}
            className="app-button-secondary gap-1.5"
          >
            <span className={cn(loading && "animate-spin")} aria-hidden="true">
              <RefreshCw className="h-3.5 w-3.5" />
            </span>
            {t("plugins.refresh")}
          </button>
        </div>
      </header>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)] overflow-hidden rounded-xl border border-border-subtle bg-surface">
        {!projection ? (
          <LoadingPanel />
        ) : projection.read_status === "error" ? (
          <div
            className="col-span-2 flex min-h-[360px] items-center justify-center p-8 text-center"
            role="alert"
          >
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
              <PluginCatalogControls
                scope={scope}
                installedCount={counts.installed}
                availableCount={counts.available}
                query={query}
                marketplace={marketplace}
                marketplaces={marketplaces}
                onScopeChange={(nextScope) => updateFilters({ scope: nextScope })}
                onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
                onMarketplaceChange={(nextMarketplace) => updateFilters({
                  marketplace: nextMarketplace,
                })}
              />
              <PluginList
                plugins={visiblePlugins}
                selectedKey={migratedSelectedKey}
                listLabel={listLabel}
                emptyTitle={emptyTitle}
                emptyDescription={emptyDescription}
                onSelect={setSelectedKey}
              />
            </section>
            {selected ? (
              <PluginDetails plugin={selected} />
            ) : (
              <aside
                aria-label={t("plugins.detailsLabel")}
                className="flex min-h-0 flex-col bg-background/40"
              >
                <PluginCatalogEmptyState
                  title={emptyTitle}
                  description={emptyDescription}
                />
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  );
}
