import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Beaker,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  MonitorCog,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { AgentIcon } from "../components/AgentIcon";
import { ToggleSwitch } from "../components/ToggleSwitch";
import type { ToolInfo } from "../lib/tauri";
import { cn } from "../utils";

/**
 * 一次性原型：在现有 /settings 路由上比较三个信息分层方案。
 * 使用 ?prototype=settings-hierarchy&variant=A|B|C 切换，所有交互只保存在内存中。
 */

type VariantKey = "A" | "B" | "C";
type SectionKey = "preferences" | "agents" | "management" | "maintenance";

const IS_PROTOTYPE_BUILD =
  import.meta.env.DEV || import.meta.env.VITE_SETTINGS_HIERARCHY_PROTOTYPE === "1";

interface SettingsHierarchyPrototypeProps {
  tools: ToolInfo[];
}

const prototypeText = {
  zh: {
    subtitle: "比较 Agent 接入、Agent Skills 管理能力与普通全局偏好的信息分层。",
    notice: "一次性原型 · 所有选择只在本窗口模拟，不会改动真实设置",
    sectionGroups: "设置分组",
    commonSettings: "常用设置",
    commonDescription: "主题、语言、文字与窗口行为",
    languageDescription: "切换原型与应用导航的界面语言。",
    closeAction: "关闭行为",
    closeActionDescription: "选择点击窗口关闭按钮后的应用行为。",
    closeAsk: "每次询问",
    closeHide: "最小化到托盘",
    closeQuit: "退出应用",
    agentAccess: "Agent 接入",
    agentAccessDescription: "检测并启用可以接收 Skills 的 Agent",
    managementDescription: "赋予指定 Agent 管理中央技能库的能力",
    maintenance: "维护与高级",
    maintenanceDescription: "自动更新、网络代理与备份高级项",
    showingAgents: "当前展示最常用的 8 个",
    updateAndNetwork: "更新与网络",
    advanced: "高级",
    gitAdvanced: "Git 备份高级配置",
    gitAdvancedDescription: "远程仓库地址与实验性 Git 引擎。",
    expand: "展开",
    overviewEyebrow: "设置概览",
    overviewTitle: "先看状态，再进入设置",
    overviewDescription: "每类设置只显示当前结果和是否需要处理，详细选项在下一层。",
    backToOverview: "返回设置概览",
    needsConfirmation: "需确认",
    healthySummary: "3 类设置正常，1 类有需要确认的高级选项",
    currentTask: "当前任务",
    taskBoundary: "任务边界",
    dailyUse: "日常使用",
    dailyUseHelper: "外观与窗口",
    connectAgent: "接入 Agent",
    connectAgentHelper: "发现与启用",
    grantManagement: "赋予管理能力",
    grantManagementHelper: "可信部署",
    maintain: "维护",
    maintainHelper: "更新与高级",
    preferenceBoundary: "这里只放高频、低风险、立即生效的个人偏好。",
    agentBoundary: "这里只决定哪些 Agent 能接收中央技能库中的 Skills。",
    managementBoundary: "这里只决定哪些已启用 Agent 能直接管理中央技能库。",
    maintenanceBoundary: "影响来源检查、网络与备份的低频配置集中在这里。",
    actionBoundary: "不混淆的两个动作",
    actionBoundaryDescription: "“启用 Agent”不会自动授予“管理 Skills”的能力。",
    variantNames: { A: "分组侧栏", B: "概览后钻取", C: "任务标签页" },
    previousVariant: "上一个方案",
    nextVariant: "下一个方案",
  },
  "zh-TW": {
    subtitle: "比較 Agent 接入、Agent Skills 管理能力與一般全域偏好的資訊分層。",
    notice: "一次性原型 · 所有選擇只在本視窗模擬，不會變更實際設定",
    sectionGroups: "設定分組",
    commonSettings: "常用設定",
    commonDescription: "主題、語言、文字與視窗行為",
    languageDescription: "切換原型與應用導覽的介面語言。",
    closeAction: "關閉行為",
    closeActionDescription: "選擇點擊視窗關閉按鈕後的應用行為。",
    closeAsk: "每次詢問",
    closeHide: "最小化到托盤",
    closeQuit: "結束應用",
    agentAccess: "Agent 接入",
    agentAccessDescription: "偵測並啟用可接收 Skills 的 Agent",
    managementDescription: "賦予指定 Agent 管理中央技能庫的能力",
    maintenance: "維護與進階",
    maintenanceDescription: "自動更新、網路代理與備份進階項目",
    showingAgents: "目前顯示最常用的 8 個",
    updateAndNetwork: "更新與網路",
    advanced: "進階",
    gitAdvanced: "Git 備份進階設定",
    gitAdvancedDescription: "遠端倉庫位址與實驗性 Git 引擎。",
    expand: "展開",
    overviewEyebrow: "設定概覽",
    overviewTitle: "先看狀態，再進入設定",
    overviewDescription: "每類設定只顯示目前結果及是否需要處理，詳細選項位於下一層。",
    backToOverview: "返回設定概覽",
    needsConfirmation: "需確認",
    healthySummary: "3 類設定正常，1 類有需要確認的進階選項",
    currentTask: "目前任務",
    taskBoundary: "任務邊界",
    dailyUse: "日常使用",
    dailyUseHelper: "外觀與視窗",
    connectAgent: "接入 Agent",
    connectAgentHelper: "發現與啟用",
    grantManagement: "賦予管理能力",
    grantManagementHelper: "可信部署",
    maintain: "維護",
    maintainHelper: "更新與進階",
    preferenceBoundary: "這裡只放高頻、低風險、立即生效的個人偏好。",
    agentBoundary: "這裡只決定哪些 Agent 能接收中央技能庫中的 Skills。",
    managementBoundary: "這裡只決定哪些已啟用 Agent 能直接管理中央技能庫。",
    maintenanceBoundary: "影響來源檢查、網路與備份的低頻設定集中在這裡。",
    actionBoundary: "不混淆的兩個動作",
    actionBoundaryDescription: "「啟用 Agent」不會自動授予「管理 Skills」能力。",
    variantNames: { A: "分組側欄", B: "概覽後下鑽", C: "任務分頁" },
    previousVariant: "上一個方案",
    nextVariant: "下一個方案",
  },
  en: {
    subtitle: "Compare how Agent access, Agent Skills management, and global preferences are organized.",
    notice: "Throwaway prototype · Choices are simulated in this window and never change real settings",
    sectionGroups: "Settings groups",
    commonSettings: "General",
    commonDescription: "Theme, language, text, and window behavior",
    languageDescription: "Change the interface language for the prototype and app navigation.",
    closeAction: "Close behavior",
    closeActionDescription: "Choose what happens when you click the window close button.",
    closeAsk: "Ask each time",
    closeHide: "Minimize to tray",
    closeQuit: "Quit app",
    agentAccess: "Agent access",
    agentAccessDescription: "Detect and enable agents that can receive Skills",
    managementDescription: "Let selected agents manage the central Skill Library",
    maintenance: "Maintenance & advanced",
    maintenanceDescription: "Auto-update, network proxy, and advanced backup options",
    showingAgents: "Showing the 8 most commonly used agents",
    updateAndNetwork: "Updates & network",
    advanced: "Advanced",
    gitAdvanced: "Advanced Git backup",
    gitAdvancedDescription: "Remote repository URL and experimental Git engine.",
    expand: "Expand",
    overviewEyebrow: "Settings overview",
    overviewTitle: "See status before opening settings",
    overviewDescription: "Each category shows its current result and attention state before revealing details.",
    backToOverview: "Back to settings overview",
    needsConfirmation: "Review",
    healthySummary: "3 settings groups are healthy; 1 advanced group needs review",
    currentTask: "Current task",
    taskBoundary: "Task boundary",
    dailyUse: "Daily use",
    dailyUseHelper: "Appearance & windows",
    connectAgent: "Connect agents",
    connectAgentHelper: "Detect & enable",
    grantManagement: "Grant management",
    grantManagementHelper: "Trusted deployment",
    maintain: "Maintain",
    maintainHelper: "Updates & advanced",
    preferenceBoundary: "Only frequent, low-risk, immediately applied preferences live here.",
    agentBoundary: "This only decides which agents can receive Skills from the central library.",
    managementBoundary: "This only decides which enabled agents can manage the central library directly.",
    maintenanceBoundary: "Low-frequency source checks, network, and backup options live here.",
    actionBoundary: "Two distinct actions",
    actionBoundaryDescription: "Enabling an agent does not automatically grant Skill management.",
    variantNames: { A: "Grouped sidebar", B: "Overview & drill-down", C: "Task tabs" },
    previousVariant: "Previous variant",
    nextVariant: "Next variant",
  },
} as const;

function usePrototypeText() {
  const { i18n } = useTranslation();
  const language = i18n.language === "zh-TW" ? "zh-TW" : i18n.language.startsWith("en") ? "en" : "zh";
  return prototypeText[language];
}

function useSectionMeta(): Record<
  SectionKey,
  { label: string; description: string; Icon: typeof Settings2 }
> {
  const { t } = useTranslation();
  const text = usePrototypeText();
  return {
    preferences: {
      label: text.commonSettings,
      description: text.commonDescription,
      Icon: SlidersHorizontal,
    },
    agents: {
      label: text.agentAccess,
      description: text.agentAccessDescription,
      Icon: MonitorCog,
    },
    management: {
      label: t("agentManagement.title"),
      description: text.managementDescription,
      Icon: ShieldCheck,
    },
    maintenance: {
      label: text.maintenance,
      description: text.maintenanceDescription,
      Icon: Wrench,
    },
  };
}

function PrototypeNotice() {
  const text = usePrototypeText();
  return (
    <div className="mb-4 flex items-center gap-2 border-b border-dashed border-accent-border pb-3 text-[12px] text-muted">
      <Beaker className="h-3.5 w-3.5 text-accent" />
      <span>{text.notice}</span>
    </div>
  );
}

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "attention" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "good" && "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
        tone === "attention" && "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "border-border-subtle bg-bg-secondary text-muted",
      )}
    >
      {children}
    </span>
  );
}

function SegmentedControl({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="app-segmented shrink-0 bg-background">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "app-segmented-button whitespace-nowrap px-3 py-1.5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
            value === option.value && "app-segmented-button-active",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] items-center justify-between gap-5 px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-primary">{title}</h3>
        <p className="mt-0.5 text-[12px] leading-5 text-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

function PreferenceSettings() {
  const { t, i18n } = useTranslation();
  const text = usePrototypeText();
  const [theme, setTheme] = useState("system");
  const [textSize, setTextSize] = useState("default");
  const [closeAction, setCloseAction] = useState("ask");
  const language = i18n.language === "zh-TW" ? "zh-TW" : i18n.language.startsWith("en") ? "en" : "zh";

  return (
    <div className="app-panel divide-y divide-border-faint overflow-hidden">
      <SettingRow title={t("settings.theme")} description={t("settings.themeDesc")}>
        <SegmentedControl
          label={t("settings.theme")}
          options={[
            { value: "light", label: t("settings.themeLight") },
            { value: "dark", label: t("settings.themeDark") },
            { value: "system", label: t("settings.themeSystem") },
          ]}
          value={theme}
          onChange={setTheme}
        />
      </SettingRow>
      <SettingRow title={t("settings.language")} description={text.languageDescription}>
        <SegmentedControl
          label={t("settings.language")}
          options={[
            { value: "zh", label: "简体中文" },
            { value: "zh-TW", label: "繁體中文" },
            { value: "en", label: "English" },
          ]}
          value={language}
          onChange={(value) => void i18n.changeLanguage(value)}
        />
      </SettingRow>
      <SettingRow title={t("settings.textSize")} description={t("settings.textSizeDesc")}>
        <SegmentedControl
          label={t("settings.textSize")}
          options={[
            { value: "small", label: t("settings.textSizeSmall") },
            { value: "default", label: t("settings.textSizeDefault") },
            { value: "large", label: t("settings.textSizeLarge") },
            { value: "xlarge", label: t("settings.textSizeXLarge") },
          ]}
          value={textSize}
          onChange={setTextSize}
        />
      </SettingRow>
      <SettingRow title={text.closeAction} description={text.closeActionDescription}>
        <SegmentedControl
          label={text.closeAction}
          options={[
            { value: "ask", label: text.closeAsk },
            { value: "hide", label: text.closeHide },
            { value: "close", label: text.closeQuit },
          ]}
          value={closeAction}
          onChange={setCloseAction}
        />
      </SettingRow>
    </div>
  );
}

function AgentAccessSettings({ tools }: SettingsHierarchyPrototypeProps) {
  const { t } = useTranslation();
  const text = usePrototypeText();
  const installed = useMemo(() => tools.filter((tool) => tool.installed).slice(0, 8), [tools]);
  const [enabledKeys, setEnabledKeys] = useState(
    () => new Set(installed.filter((tool) => tool.enabled).map((tool) => tool.key)),
  );

  const toggle = (key: string) => {
    setEnabledKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <StatusPill tone="good">{t("settings.detectedAgents")} {tools.filter((tool) => tool.installed).length}</StatusPill>
          <span>{text.showingAgents}</span>
        </div>
        <button type="button" className="app-button-secondary px-3 py-2">{t("settings.refresh")}</button>
      </div>
      <div className="app-panel divide-y divide-border-faint overflow-hidden">
        {installed.map((tool) => {
          const enabled = enabledKeys.has(tool.key);
          return (
            <div key={tool.key} className="flex items-center gap-3 px-4 py-3">
              <AgentIcon agentKey={tool.key} displayName={tool.display_name} className="h-7 w-7 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-primary">{tool.display_name}</div>
                <div className="truncate font-mono text-[11px] text-muted">{tool.skills_dir}</div>
              </div>
              <span className="text-[12px] text-muted">
                {enabled ? t("settings.enabledState") : t("settings.disabledState")}
              </span>
              <ToggleSwitch
                checked={enabled}
                title={`${t(enabled ? "settings.disableAgent" : "settings.enableAgent")} ${tool.display_name}`}
                onChange={() => toggle(tool.key)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentManagementSettings({ tools }: SettingsHierarchyPrototypeProps) {
  const { t } = useTranslation();
  const candidates = useMemo(() => tools.filter((tool) => tool.installed && tool.enabled).slice(0, 5), [tools]);
  const [deployed, setDeployed] = useState(() => new Set(candidates.slice(0, 1).map((tool) => tool.key)));

  const toggle = (key: string) => {
    setDeployed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
      <div className="app-panel p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{t("agentManagement.skillLabel")}</div>
            <h3 className="mt-1 text-[16px] font-semibold text-primary">manage-skills</h3>
          </div>
          <StatusPill tone="good">{t("agentManagement.trustedStatus")}</StatusPill>
        </div>
        <p className="text-[12px] leading-5 text-muted">
          {t("agentManagement.trustedDescription")}
        </p>
        <div className="mt-5 grid grid-cols-2 divide-x divide-border-faint border-y border-border-faint py-3 text-center">
          <div>
            <div className="text-[18px] font-semibold tabular-nums text-primary">{deployed.size}</div>
            <div className="text-[11px] text-muted">{t("agentManagement.currentDeployments")}</div>
          </div>
          <div>
            <div className="text-[18px] font-semibold tabular-nums text-primary">0</div>
            <div className="text-[11px] text-muted">{t("agentManagement.pendingChanges")}</div>
          </div>
        </div>
        <button type="button" className="mt-4 text-[12px] font-medium text-accent hover:text-accent-light">{t("agentManagement.viewInLibrary")}</button>
      </div>

      <div className="app-panel overflow-hidden">
        <div className="border-b border-border-faint px-4 py-3">
          <h3 className="text-[14px] font-semibold text-primary">{t("agentManagement.targetsTitle")}</h3>
          <p className="mt-0.5 text-[12px] text-muted">{t("agentManagement.targetsDescription")}</p>
        </div>
        {candidates.map((tool) => {
          const enabled = deployed.has(tool.key);
          return (
            <div key={tool.key} className="flex items-center gap-3 border-b border-border-faint px-4 py-3 last:border-0">
              <AgentIcon agentKey={tool.key} displayName={tool.display_name} className="h-7 w-7 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-primary">{tool.display_name}</div>
                <div className="text-[11px] text-muted">
                  {enabled ? t("agentManagement.enabledStatus") : t("agentManagement.disabledStatus")}
                </div>
              </div>
              <ToggleSwitch
                checked={enabled}
                title={t(enabled ? "agentManagement.disableAgentLabel" : "agentManagement.enableAgentLabel", {
                  name: tool.display_name,
                })}
                onChange={() => toggle(tool.key)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MaintenanceSettings() {
  const { t } = useTranslation();
  const text = usePrototypeText();
  const [interval, setIntervalValue] = useState("1h");
  const [applyMode, setApplyMode] = useState("off");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="app-section-title mb-2">{text.updateAndNetwork}</h3>
        <div className="app-panel divide-y divide-border-faint overflow-hidden">
          <SettingRow title={t("settings.autoUpdate.intervalLabel")} description={t("settings.autoUpdate.intervalDesc")}>
            <SegmentedControl
              label={t("settings.autoUpdate.intervalLabel")}
              options={[
                { value: "off", label: t("settings.autoUpdate.intervalOff") },
                { value: "1h", label: t("settings.autoUpdate.interval1h") },
                { value: "6h", label: t("settings.autoUpdate.interval6h") },
                { value: "24h", label: t("settings.autoUpdate.interval24h") },
              ]}
              value={interval}
              onChange={setIntervalValue}
            />
          </SettingRow>
          <SettingRow title={t("settings.autoUpdate.applyLabel")} description={t("settings.autoUpdate.applyDesc")}>
            <SegmentedControl
              label={t("settings.autoUpdate.applyLabel")}
              options={[
                { value: "off", label: t("settings.autoUpdate.applyOff") },
                { value: "on", label: t("settings.autoUpdate.applyOn") },
              ]}
              value={applyMode}
              onChange={setApplyMode}
            />
          </SettingRow>
          <SettingRow title={t("settings.proxyConfig")} description={t("settings.proxyUrlDesc")}>
            <code className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-secondary">http://127.0.0.1:7890</code>
          </SettingRow>
        </div>
      </div>
      <div>
        <h3 className="app-section-title mb-2">{text.advanced}</h3>
        <div className="app-panel divide-y divide-border-faint overflow-hidden">
          <SettingRow title={t("settings.repoPath")} description={t("settings.repoPathDesc")}>
            <code className="text-[12px] text-secondary">~/.skill-expert</code>
          </SettingRow>
          <SettingRow title={text.gitAdvanced} description={text.gitAdvancedDescription}>
            <button type="button" className="app-button-secondary px-3 py-2">{text.expand}</button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function SectionContent({ section, tools }: { section: SectionKey; tools: ToolInfo[] }) {
  if (section === "preferences") return <PreferenceSettings />;
  if (section === "agents") return <AgentAccessSettings tools={tools} />;
  if (section === "management") return <AgentManagementSettings tools={tools} />;
  return <MaintenanceSettings />;
}

function ContentHeader({ section, eyebrow }: { section: SectionKey; eyebrow?: string }) {
  const sectionMeta = useSectionMeta();
  const { Icon, label, description } = sectionMeta[section];
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-accent-border bg-accent-bg text-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        {eyebrow && <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{eyebrow}</div>}
        <h2 className="text-[18px] font-semibold tracking-tight text-primary">{label}</h2>
        <p className="mt-1 text-[12px] text-muted">{description}</p>
      </div>
    </div>
  );
}

function VariantA({ tools }: SettingsHierarchyPrototypeProps) {
  const text = usePrototypeText();
  const sectionMeta = useSectionMeta();
  const [section, setSection] = useState<SectionKey>("preferences");
  return (
    <div className="grid min-h-[620px] overflow-hidden rounded-xl border border-border-subtle bg-surface lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label={text.sectionGroups} className="border-b border-border-subtle bg-bg-secondary/70 p-3 lg:border-b-0 lg:border-r">
        <div className="px-2 pb-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{text.sectionGroups}</div>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
          {(Object.keys(sectionMeta) as SectionKey[]).map((key) => {
            const { Icon, label, description } = sectionMeta[key];
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                  active ? "bg-surface text-primary shadow-card" : "text-muted hover:bg-surface-hover hover:text-secondary",
                )}
              >
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active && "text-accent")} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{label}</span>
                  <span className="mt-0.5 hidden text-[11px] leading-4 lg:block">{description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="min-w-0 p-5 lg:p-7">
        <ContentHeader section={section} />
        <SectionContent section={section} tools={tools} />
      </div>
    </div>
  );
}

function OverviewRow({
  section,
  metric,
  detail,
  attention,
  onClick,
}: {
  section: SectionKey;
  metric: string;
  detail: string;
  attention?: boolean;
  onClick: () => void;
}) {
  const sectionMeta = useSectionMeta();
  const text = usePrototypeText();
  const { Icon, label, description } = sectionMeta[section];
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 px-5 py-4 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-secondary text-muted group-hover:text-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[14px] font-semibold text-primary">{label}</h3>
          {attention && <StatusPill tone="attention">{text.needsConfirmation}</StatusPill>}
        </div>
        <p className="mt-0.5 text-[12px] text-muted">{description}</p>
      </div>
      <div className="hidden min-w-[170px] text-right sm:block">
        <div className="text-[13px] font-medium text-secondary">{metric}</div>
        <div className="mt-0.5 text-[11px] text-muted">{detail}</div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted" />
    </button>
  );
}

function VariantB({ tools }: SettingsHierarchyPrototypeProps) {
  const { t } = useTranslation();
  const text = usePrototypeText();
  const [section, setSection] = useState<SectionKey | null>(null);
  if (section) {
    return (
      <div>
        <button type="button" onClick={() => setSection(null)} className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-secondary">
          <ChevronLeft className="h-3.5 w-3.5" />
          {text.backToOverview}
        </button>
        <ContentHeader section={section} eyebrow={text.overviewEyebrow} />
        <SectionContent section={section} tools={tools} />
      </div>
    );
  }

  const installed = tools.filter((tool) => tool.installed).length;
  const enabled = tools.filter((tool) => tool.installed && tool.enabled).length;
  return (
    <div>
      <div className="mb-5 max-w-[680px]">
        <h2 className="text-[20px] font-semibold tracking-tight text-primary">{text.overviewTitle}</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">{text.overviewDescription}</p>
      </div>
      <div className="app-panel divide-y divide-border-faint overflow-hidden">
        <OverviewRow section="preferences" metric={`${t("settings.themeSystem")} · ${t("settings.language")}`} detail={t("settings.textSizeDefault")} onClick={() => setSection("preferences")} />
        <OverviewRow section="agents" metric={`${t("settings.detectedAgents")} ${installed} · ${t("settings.enabledAgents")} ${enabled}`} detail={`5 ${t("settings.supportedAgents")}`} onClick={() => setSection("agents")} />
        <OverviewRow section="management" metric={t("agentManagement.deployedCount", { count: 1 })} detail={`${t("agentManagement.trustedStatus")} · ${t("agentManagement.pendingChanges")} 0`} onClick={() => setSection("management")} />
        <OverviewRow section="maintenance" metric={t("settings.autoUpdate.interval1h")} detail={text.maintenanceDescription} attention onClick={() => setSection("maintenance")} />
      </div>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
        <CircleCheck className="h-3.5 w-3.5 text-accent" />
        {text.healthySummary}
      </div>
    </div>
  );
}

function VariantC({ tools }: SettingsHierarchyPrototypeProps) {
  const text = usePrototypeText();
  const [section, setSection] = useState<SectionKey>("preferences");
  const taskTabs: Array<{ key: SectionKey; label: string; helper: string }> = [
    { key: "preferences", label: text.dailyUse, helper: text.dailyUseHelper },
    { key: "agents", label: text.connectAgent, helper: text.connectAgentHelper },
    { key: "management", label: text.grantManagement, helper: text.grantManagementHelper },
    { key: "maintenance", label: text.maintain, helper: text.maintainHelper },
  ];
  return (
    <div>
      <div role="tablist" aria-label={text.currentTask} className="mb-6 grid overflow-hidden rounded-xl border border-border-subtle bg-surface sm:grid-cols-2 lg:grid-cols-4">
        {taskTabs.map(({ key, label, helper }) => {
          const active = section === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSection(key)}
              className={cn(
                "relative border-b border-border-faint px-4 py-3 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:border-r sm:[&:nth-child(2)]:border-r-0 lg:border-b-0 lg:[&:nth-child(2)]:border-r",
                active ? "bg-accent-bg" : "hover:bg-surface-hover",
              )}
            >
              <span className={cn("block text-[13px] font-semibold", active ? "text-accent-dark dark:text-accent-light" : "text-secondary")}>{label}</span>
              <span className="mt-0.5 block text-[11px] text-muted">{helper}</span>
              {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
        <main className="min-w-0">
          <ContentHeader section={section} eyebrow={text.currentTask} />
          <SectionContent section={section} tools={tools} />
        </main>
        <aside className="border-l border-border-faint pl-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{text.taskBoundary}</div>
          <div className="mt-3 space-y-4 text-[12px] leading-5 text-muted">
            {section === "preferences" && <p>{text.preferenceBoundary}</p>}
            {section === "agents" && <p>{text.agentBoundary}</p>}
            {section === "management" && <p>{text.managementBoundary}</p>}
            {section === "maintenance" && <p>{text.maintenanceBoundary}</p>}
            <div className="border-t border-border-faint pt-3">
              <div className="flex items-center gap-2 text-secondary">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" />
                {text.actionBoundary}
              </div>
              <p className="mt-1">{text.actionBoundaryDescription}</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PrototypeSwitcher({ variant, onChange }: { variant: VariantKey; onChange: (variant: VariantKey) => void }) {
  const text = usePrototypeText();
  const variants: VariantKey[] = ["A", "B", "C"];
  const move = (offset: number) => {
    const index = variants.indexOf(variant);
    onChange(variants[(index + offset + variants.length) % variants.length]);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!IS_PROTOTYPE_BUILD) return null;
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center rounded-full border border-zinc-700 bg-zinc-950 p-1 text-white shadow-2xl">
      <button type="button" onClick={() => move(-1)} aria-label={text.previousVariant} className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-400">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div aria-live="polite" className="min-w-[150px] px-3 text-center text-[12px] font-medium">
        {variant} · {text.variantNames[variant]}
      </div>
      <button type="button" onClick={() => move(1)} aria-label={text.nextVariant} className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-400">
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export function SettingsHierarchyPrototype({ tools }: SettingsHierarchyPrototypeProps) {
  const { t } = useTranslation();
  const text = usePrototypeText();
  const initial = new URLSearchParams(window.location.search).get("variant");
  const [variant, setVariant] = useState<VariantKey>(initial === "B" || initial === "C" ? initial : "A");

  const changeVariant = (next: VariantKey) => {
    const params = new URLSearchParams(window.location.search);
    params.set("prototype", "settings-hierarchy");
    params.set("variant", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    setVariant(next);
  };

  return (
    <div className="app-page app-page-narrow pb-20">
      <div className="app-page-header">
        <h1 className="app-page-title flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-accent" />
          {t("settings.title")}
        </h1>
        <p className="app-page-subtitle">{text.subtitle}</p>
      </div>
      <PrototypeNotice />
      {variant === "A" && <VariantA tools={tools} />}
      {variant === "B" && <VariantB tools={tools} />}
      {variant === "C" && <VariantC tools={tools} />}
      <PrototypeSwitcher variant={variant} onChange={changeVariant} />
    </div>
  );
}
