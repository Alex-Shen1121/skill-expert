import { ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentPluginScope } from "../../lib/agentPluginView";
import { cn } from "../../utils";

interface PluginCatalogControlsProps {
  scope: AgentPluginScope;
  installedCount: number;
  availableCount: number;
  query: string;
  marketplace: string;
  marketplaces: string[];
  onScopeChange: (scope: AgentPluginScope) => void;
  onQueryChange: (query: string) => void;
  onMarketplaceChange: (marketplace: string) => void;
}

export function PluginCatalogControls({
  scope,
  installedCount,
  availableCount,
  query,
  marketplace,
  marketplaces,
  onScopeChange,
  onQueryChange,
  onMarketplaceChange,
}: PluginCatalogControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="shrink-0 space-y-3 border-b border-border-subtle p-3">
      <div
        role="tablist"
        aria-label={t("plugins.scopeLabel")}
        className="app-segmented"
      >
        {([
          ["installed", installedCount],
          ["available", availableCount],
        ] as const).map(([value, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            aria-controls="plugin-catalog-list"
            onClick={() => onScopeChange(value)}
            className={cn(
              "app-segmented-button flex-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              scope === value && "app-segmented-button-active",
            )}
          >
            {t(`plugins.${value}`)} {t("plugins.count", { count })}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-[190px] flex-1">
          <span className="sr-only">{t("plugins.searchLabel")}</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("plugins.searchPlaceholder")}
            className="app-input h-9 w-full pl-9"
          />
        </label>

        <label className="relative min-w-[180px] flex-1">
          <span className="sr-only">{t("plugins.marketplaceLabel")}</span>
          <select
            value={marketplace}
            onChange={(event) => onMarketplaceChange(event.target.value)}
            className="app-input h-9 w-full appearance-none pr-8"
          >
            <option value="all">{t("plugins.allMarketplaces")}</option>
            {marketplaces.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
        </label>
      </div>
    </div>
  );
}
