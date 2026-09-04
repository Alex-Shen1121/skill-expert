import {
  AppWindow,
  BadgeCheck,
  BookOpen,
  Check,
  CircleAlert,
  Download,
  Globe2,
  KeyRound,
  Plug,
  RefreshCw,
  Unplug,
  CircleHelp,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentPluginAuthPolicy,
  AgentPluginInstallStatus,
  AgentPluginSummary,
  AgentPluginSkill,
} from "../../lib/agentPlugins";
import { cn } from "../../utils";
import { PluginMark } from "./PluginMark";
import { isSafePluginImageDataUrl } from "./pluginVisual";

function statusKey(status: AgentPluginInstallStatus): string {
  return `plugins.status.${status}`;
}

function authKey(policy: AgentPluginAuthPolicy | null): string {
  if (policy === "on_install") return "plugins.auth.onInstall";
  if (policy === "on_use") return "plugins.auth.onUse";
  if (policy === "none") return "plugins.auth.none";
  return "plugins.unknown";
}

export function PluginStatusBadge({ status }: { status: AgentPluginInstallStatus }) {
  const { t } = useTranslation();
  const content = status === "installed_enabled"
    ? { Icon: Check, className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" }
    : status === "installed_disabled"
      ? { Icon: Unplug, className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" }
      : { Icon: Download, className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" };
  return (
    <span
      role="status"
      aria-label={t("plugins.installStatusIndicator", { status: t(statusKey(status)) })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        content.className,
      )}
    >
      <content.Icon className="h-3 w-3" aria-hidden="true" />
      {t(statusKey(status))}
    </span>
  );
}

function AuthPolicyBadge({ policy }: { policy: AgentPluginAuthPolicy | null }) {
  const { t } = useTranslation();
  const label = t(authKey(policy));
  const content = policy === "none"
    ? { Icon: BadgeCheck, className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" }
    : policy === "on_install" || policy === "on_use"
      ? { Icon: KeyRound, className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" }
      : { Icon: CircleHelp, className: "bg-bg-secondary text-muted" };
  return (
    <span
      role="status"
      aria-label={t("plugins.authPolicyIndicator", { policy: label })}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
        content.className,
      )}
    >
      <content.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function DetailsCompletenessBadge({ complete }: { complete: boolean }) {
  const { t } = useTranslation();
  const label = t(complete ? "plugins.detailsComplete" : "plugins.detailsIncompleteShort");
  const Icon = complete ? BadgeCheck : CircleAlert;
  return (
    <span
      role="status"
      aria-label={t("plugins.detailsCompletenessIndicator", { status: label })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        complete
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

interface CapabilityGroupProps {
  label: string;
  Icon: LucideIcon;
  items: string[] | AgentPluginSkill[];
  skills?: boolean;
}

function CapabilityGroup({ label, Icon, items, skills = false }: CapabilityGroupProps) {
  const { t } = useTranslation();
  const declared = items.length > 0;
  return (
    <section role="region" aria-label={label}>
      <div
        role="status"
        aria-label={t(
          declared
            ? "plugins.capabilities.declaredIndicator"
            : "plugins.capabilities.undeclaredIndicator",
          { label, count: items.length },
        )}
        className={cn(
          "mb-2 flex items-center gap-2",
          declared
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-muted",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        <h3 className="text-[12px] font-semibold tracking-[0.04em]">{label}</h3>
        <span className="text-[11px] tabular-nums text-tertiary">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="divide-y divide-border-faint rounded-lg border border-border-subtle bg-surface">
          {items.map((item) => {
            const name = typeof item === "string" ? item : item.name;
            const description = skills && typeof item !== "string" ? item.description : null;
            return (
              <div key={name} className="px-3 py-2.5">
                <p className="break-all font-mono text-[11px] text-tertiary">{name}</p>
                {description && (
                  <p className="mt-1 text-[11px] leading-4 text-muted">{description}</p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[12px] text-muted">{t("plugins.capabilities.undeclared")}</p>
      )}
    </section>
  );
}

export function PluginDetails({ plugin }: { plugin: AgentPluginSummary }) {
  const { t } = useTranslation();
  const groups = [
    { key: "skills", label: t("plugins.capabilities.skills"), Icon: BookOpen, items: plugin.details.skills, skills: true },
    { key: "mcp", label: t("plugins.capabilities.mcp"), Icon: Wrench, items: plugin.details.mcp_servers },
    { key: "hooks", label: t("plugins.capabilities.hooks"), Icon: Zap, items: plugin.details.hook_events },
    { key: "connectors", label: t("plugins.capabilities.connectors"), Icon: Plug, items: plugin.details.connectors },
    { key: "browser", label: t("plugins.capabilities.browserExtensions"), Icon: Globe2, items: plugin.details.browser_extensions },
    { key: "ui", label: t("plugins.capabilities.customUi"), Icon: AppWindow, items: plugin.details.custom_ui },
  ];
  const screenshots = plugin.details.screenshot_data_urls.filter(isSafePluginImageDataUrl);

  return (
    <aside aria-label={t("plugins.detailsLabel")} className="min-h-0 bg-background/40">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-start gap-3 border-b border-border-subtle p-5">
          <PluginMark plugin={plugin} size="large" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold tracking-tight text-primary">
                {plugin.display_name}
              </h2>
              <PluginStatusBadge status={plugin.install_status} />
              <DetailsCompletenessBadge
                complete={plugin.details.completeness === "complete"}
              />
              {plugin.update_available === true && (
                <span
                  role="status"
                  aria-label={t("plugins.updateAvailable")}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  {t("plugins.updateAvailable")}
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">
              {plugin.identity.plugin_id}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 pb-20 scrollbar-hide">
          {plugin.details.completeness === "incomplete" && (
            <div
              role="note"
              className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-5 text-amber-800 dark:text-amber-200"
            >
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t("plugins.detailsIncomplete")}</span>
            </div>
          )}

          <div>
            <p className="text-[13px] leading-5 text-tertiary">
              {plugin.details.description ?? t("plugins.unknown")}
            </p>
            {plugin.details.declared_capabilities.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {plugin.details.declared_capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="rounded-md border border-border-faint bg-bg-secondary px-2 py-1 text-[11px] text-muted"
                  >
                    {capability}
                  </span>
                ))}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-[112px_1fr] gap-x-4 gap-y-2.5 text-[12px]">
            <dt className="text-muted">{t("plugins.fields.agent")}</dt>
            <dd className="text-secondary">Codex</dd>
            <dt className="text-muted">{t("plugins.fields.developer")}</dt>
            <dd className="text-secondary">{plugin.details.developer ?? t("plugins.unknown")}</dd>
            <dt className="text-muted">{t("plugins.fields.category")}</dt>
            <dd className="text-secondary">{plugin.details.category ?? t("plugins.unknown")}</dd>
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
            <dd><AuthPolicyBadge policy={plugin.auth_policy} /></dd>
          </dl>

          {plugin.details.default_prompts.length > 0 && (
            <section aria-label={t("plugins.defaultPrompts")}>
              <h3 className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-muted">
                {t("plugins.defaultPrompts")}
              </h3>
              <ul className="space-y-1.5 rounded-lg border border-border-subtle bg-surface p-3 text-[12px] leading-5 text-tertiary">
                {plugin.details.default_prompts.map((prompt) => <li key={prompt}>{prompt}</li>)}
              </ul>
            </section>
          )}

          {groups.map((group) => (
            <CapabilityGroup
              key={group.key}
              label={group.label}
              Icon={group.Icon}
              items={group.items}
              skills={group.skills}
            />
          ))}

          {screenshots.length > 0 && (
            <section aria-label={t("plugins.screenshots")}>
              <h3 className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-muted">
                {t("plugins.screenshots")}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {screenshots.map((screenshot, index) => (
                  <img
                    key={`${index}-${screenshot.slice(-16)}`}
                    src={screenshot}
                    alt={t("plugins.screenshotAlt", { index: index + 1 })}
                    className="w-full rounded-lg border border-border-subtle bg-surface object-cover"
                  />
                ))}
              </div>
            </section>
          )}

          <details className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
            <summary className="cursor-pointer text-[12px] font-medium text-tertiary">
              {t("plugins.technicalDetails")}
            </summary>
            <dl className="mt-3 grid grid-cols-[112px_1fr] gap-x-3 gap-y-2 border-t border-border-faint pt-3 text-[11px]">
              <dt className="text-muted">{t("plugins.fields.sourceType")}</dt>
              <dd className="break-all font-mono text-tertiary">
                {plugin.details.technical.source_type ?? t("plugins.unknown")}
              </dd>
              <dt className="text-muted">{t("plugins.fields.location")}</dt>
              <dd className="break-all font-mono text-tertiary">
                {plugin.details.technical.location ?? t("plugins.unknown")}
              </dd>
            </dl>
          </details>
        </div>
      </div>
    </aside>
  );
}
