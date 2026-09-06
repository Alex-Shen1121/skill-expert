import { Puzzle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentPluginSummary } from "../../lib/agentPlugins";
import { cn } from "../../utils";
import { isSafePluginImageDataUrl, isSafePluginImageUrl } from "./pluginVisual";

interface PluginMarkProps {
  plugin: Pick<AgentPluginSummary, "display_name" | "details">;
  size?: "small" | "large";
}

export function PluginMark({ plugin, size = "small" }: PluginMarkProps) {
  const { t } = useTranslation();
  const imageSource = isSafePluginImageDataUrl(plugin.details.icon_data_url)
    ? plugin.details.icon_data_url
    : isSafePluginImageUrl(plugin.details.icon_url)
      ? plugin.details.icon_url
      : null;
  const [failedImageSource, setFailedImageSource] = useState<string | null>(null);
  const large = size === "large";
  const className = cn(
    "flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-accent/20 bg-accent/10 text-accent",
    large ? "h-14 w-14" : "h-9 w-9",
  );

  if (imageSource && imageSource !== failedImageSource) {
    return (
      <span
        className={className}
        role="img"
        aria-label={t("plugins.pluginIcon", { name: plugin.display_name })}
      >
        <img
          src={imageSource}
          alt=""
          onError={() => setFailedImageSource(imageSource)}
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
