import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { PluginCatalogControls } from "../components/plugins/PluginCatalogControls";
import {
  PluginCatalogEmptyState,
  PluginList,
} from "../components/plugins/PluginList";
import {
  PluginDetails,
} from "../components/plugins/PluginDetails";
import {
  agentPluginIdentityKey,
  getAgentPluginDetails,
  getAgentPluginProjection,
  type AgentPluginDetailsProjection,
  type AgentPluginProjection,
} from "../lib/agentPlugins";
import { agentPluginErrorMessageKey } from "../lib/agentPluginErrors";
import {
  getAgentPluginMarketplaces,
  getAgentPluginScopeCounts,
  getMigratedAgentPluginSelection,
  getVisibleAgentPlugins,
  type AgentPluginScope,
} from "../lib/agentPluginView";
import { cn } from "../utils";

type DetailCacheEntry = { read_status: "loading" } | AgentPluginDetailsProjection;

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
  const [detailsByIdentity, setDetailsByIdentity] = useState<Map<string, DetailCacheEntry>>(
    () => new Map(),
  );
  const requestSequence = useRef(0);
  const detailsGeneration = useRef(0);
  const detailRequests = useRef(new Set<string>());

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
          if (next.read_status === "ready") {
            detailsGeneration.current += 1;
            detailRequests.current.clear();
            setDetailsByIdentity(new Map());
            setMarketplace((current) => (
              current === "all"
              || [...next.installed, ...next.available].some(
                (plugin) => plugin.identity.marketplace_name === current,
              )
                ? current
                : "all"
            ));
          }
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
      detailsGeneration.current += 1;
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
  const selectedIdentityKey = selected ? agentPluginIdentityKey(selected.identity) : null;
  const selectedDetailState = selectedIdentityKey
    ? detailsByIdentity.get(selectedIdentityKey)
    : undefined;
  const selectedNeedsRemoteDetails = selected?.install_status !== "available"
    && selected?.details.technical.source_type === "remote";
  const scopeComplete = scope === "installed"
    ? readyProjection?.installed_complete !== false
    : readyProjection?.available_complete !== false;

  useEffect(() => {
    if (
      !selected
      || !selectedIdentityKey
      || !selectedNeedsRemoteDetails
      || selectedDetailState
      || detailRequests.current.has(selectedIdentityKey)
    ) {
      return;
    }
    const generation = detailsGeneration.current;
    detailRequests.current.add(selectedIdentityKey);
    queueMicrotask(() => {
      if (generation !== detailsGeneration.current) return;
      setDetailsByIdentity((current) => new Map(current).set(
        selectedIdentityKey,
        { read_status: "loading" },
      ));
    });
    void getAgentPluginDetails(selected.identity)
      .catch((): AgentPluginDetailsProjection => ({
        read_status: "error",
        identity: selected.identity,
        error: { kind: "internal" },
      }))
      .then((result) => {
        if (generation !== detailsGeneration.current) return;
        const matchingIdentity = agentPluginIdentityKey(result.identity) === selectedIdentityKey;
        setDetailsByIdentity((current) => new Map(current).set(
          selectedIdentityKey,
          matchingIdentity
            ? result
            : {
                read_status: "error",
                identity: selected.identity,
                error: { kind: "contract_incompatible" },
              },
        ));
      });
  }, [selected, selectedDetailState, selectedIdentityKey, selectedNeedsRemoteDetails]);

  const selectedWithDetails = selected
    && selectedDetailState?.read_status === "ready"
    ? { ...selected, details: selectedDetailState.details }
    : selected;

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
    ? t(
        scope === "available" && readyProjection?.available_complete === false
          ? "plugins.partialAvailable"
          : "plugins.emptyDescription",
      )
    : t("plugins.noMatchesDescription");
  const listLabel = t(
    scope === "installed" ? "plugins.listLabel" : "plugins.availableListLabel",
  );

  return (
    <div
      className="plugin-catalog-page flex flex-col"
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

      <div className="plugin-catalog-frame mt-4 min-h-0 flex-1">
        <div className="plugin-catalog-grid grid h-full min-h-0 overflow-hidden rounded-xl border border-border-subtle bg-surface">
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
                {t(agentPluginErrorMessageKey("plugins", projection.error.kind))}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {[
                  "cli_unavailable",
                  "configured_path_invalid",
                  "cli_not_runnable",
                ].includes(projection.error.kind) && (
                  <a
                    href="/settings?section=codex-cli#codex-cli-settings"
                    className="app-button-secondary"
                  >
                    {t("plugins.actions.openCliSettings")}
                  </a>
                )}
                <button
                  type="button"
                  onClick={loadProjection}
                  className="app-button-secondary"
                >
                  {t("plugins.actions.retry")}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="flex min-h-0 flex-col border-r border-border-subtle">
              <PluginCatalogControls
                scope={scope}
                installedCount={counts.installed}
                installedComplete={projection.installed_complete !== false}
                availableCount={counts.available}
                availableComplete={projection.available_complete !== false}
                query={query}
                marketplace={marketplace}
                marketplaces={marketplaces}
                onScopeChange={(nextScope) => updateFilters({ scope: nextScope })}
                onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
                onMarketplaceChange={(nextMarketplace) => updateFilters({
                  marketplace: nextMarketplace,
                })}
              />
              {!scopeComplete && (
                <div
                  role="note"
                  className="m-3 mb-0 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-5 text-amber-800 dark:text-amber-200"
                >
                  <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">
                    {t(
                      scope === "installed"
                        ? "plugins.partialInstalled"
                        : "plugins.partialAvailable",
                      { count: counts.installed },
                    )}
                  </span>
                  <button type="button" className="app-button-secondary" onClick={loadProjection}>
                    {t("plugins.actions.retry")}
                  </button>
                </div>
              )}
              <PluginList
                plugins={visiblePlugins}
                selectedKey={migratedSelectedKey}
                listLabel={listLabel}
                emptyTitle={emptyTitle}
                emptyDescription={emptyDescription}
                onSelect={setSelectedKey}
              />
            </section>
            {selectedWithDetails ? (
              <PluginDetails
                plugin={selectedWithDetails}
                detailsLoading={selectedDetailState?.read_status === "loading"}
                detailsError={selectedDetailState?.read_status === "error"}
                onRetryDetails={() => {
                  if (!selectedIdentityKey) return;
                  detailRequests.current.delete(selectedIdentityKey);
                  setDetailsByIdentity((current) => {
                    const next = new Map(current);
                    next.delete(selectedIdentityKey);
                    return next;
                  });
                }}
              />
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
    </div>
  );
}
