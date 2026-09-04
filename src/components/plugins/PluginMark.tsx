import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentPluginSummary } from "../../lib/agentPlugins";
import { cn } from "../../utils";
import { isSafePluginImageDataUrl } from "./pluginVisual";

interface PluginMarkProps {
  plugin: Pick<AgentPluginSummary, "display_name" | "details">;
  size?: "small" | "large";
}

export function PluginMark({ plugin, size = "small" }: PluginMarkProps) {
  const { t } = useTranslation();
  const large = size === "large";
  const className = cn(
    "flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-accent/20 bg-accent/10 text-accent",
    large ? "h-14 w-14" : "h-9 w-9",
  );

  if (isSafePluginImageDataUrl(plugin.details.icon_data_url)) {
    return (
      <span
        className={className}
        role="img"
        aria-label={t("plugins.pluginIcon", { name: plugin.display_name })}
      >
        <img
          src={plugin.details.icon_data_url}
          alt=""
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span className={className} role="img" aria-label={t("plugins.defaultIcon")}>
      <Puzzle className={large ? "h-6 w-6" : "h-4 w-4"} aria-hidden="true" />
    </span>
  );
}
