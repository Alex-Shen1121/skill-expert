import { useEffect, useMemo, useState } from "react";
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

const variantNames: Record<VariantKey, string> = {
  A: "分组侧栏",
  B: "概览后钻取",
  C: "任务标签页",
};

const sectionMeta: Record<
  SectionKey,
  {
    label: string;
    description: string;
    Icon: typeof Settings2;
  }
> = {
  preferences: {
    label: "常用设置",
    description: "主题、语言、文字与窗口行为",
    Icon: SlidersHorizontal,
  },
  agents: {
    label: "Agent 接入",
    description: "检测并启用可以接收 Skills 的 Agent",
    Icon: MonitorCog,
  },
  management: {
    label: "Agent 管理 Skills",
    description: "赋予指定 Agent 管理中央技能库的能力",
    Icon: ShieldCheck,
  },
  maintenance: {
    label: "维护与高级",
    description: "自动更新、网络代理与备份高级项",
    Icon: Wrench,
  },
};

function PrototypeNotice() {
  return (
    <div className="mb-4 flex items-center gap-2 border-b border-dashed border-accent-border pb-3 text-[12px] text-muted">
      <Beaker className="h-3.5 w-3.5 text-accent" />
      <span>一次性原型 · 所有选择只在本窗口模拟，不会改动真实设置</span>
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
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="app-segmented shrink-0 bg-background">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "app-segmented-button whitespace-nowrap px-3 py-1.5",
            value === option && "app-segmented-button-active",
          )}
        >
          {option}
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
  const [theme, setTheme] = useState("跟随系统");
  const [language, setLanguage] = useState("简体中文");
  const [textSize, setTextSize] = useState("默认");
  const [closeAction, setCloseAction] = useState("每次询问");

  return (
    <div className="app-panel divide-y divide-border-faint overflow-hidden">
      <SettingRow title="主题" description="选择应用的外观主题。">
        <SegmentedControl label="主题" options={["浅色", "深色", "跟随系统"]} value={theme} onChange={setTheme} />
      </SettingRow>
      <SettingRow title="语言" description="界面语言会立即切换。">
        <SegmentedControl label="语言" options={["简体中文", "繁體中文", "English"]} value={language} onChange={setLanguage} />
      </SettingRow>
      <SettingRow title="文字大小" description="调整应用的基础字号。">
        <SegmentedControl label="文字大小" options={["小", "默认", "大", "特大"]} value={textSize} onChange={setTextSize} />
      </SettingRow>
      <SettingRow title="关闭行为" description="选择点击窗口关闭按钮后的应用行为。">
        <SegmentedControl label="关闭行为" options={["每次询问", "最小化到托盘", "退出应用"]} value={closeAction} onChange={setCloseAction} />
      </SettingRow>
    </div>
  );
}

function AgentToggle({ enabled, label, onClick }: { enabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full outline-none ring-offset-2 ring-offset-surface transition-colors focus-visible:ring-2 focus-visible:ring-accent",
        enabled ? "bg-accent" : "bg-surface-active",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          enabled ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function AgentAccessSettings({ tools }: SettingsHierarchyPrototypeProps) {
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
          <StatusPill tone="good">已检测 {tools.filter((tool) => tool.installed).length}</StatusPill>
          <span>当前展示最常用的 8 个</span>
        </div>
        <button type="button" className="app-button-secondary px-3 py-2">重新检测</button>
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
              <span className="text-[12px] text-muted">{enabled ? "已启用" : "未启用"}</span>
              <AgentToggle enabled={enabled} label={`${enabled ? "关闭" : "开启"} ${tool.display_name}`} onClick={() => toggle(tool.key)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentManagementSettings({ tools }: SettingsHierarchyPrototypeProps) {
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
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">管理 Skill</div>
            <h3 className="mt-1 text-[16px] font-semibold text-primary">manage-skills</h3>
          </div>
          <StatusPill tone="good">来源可信</StatusPill>
        </div>
        <p className="text-[12px] leading-5 text-muted">
          Agent 通过已验证固定来源的管理 Skill 调用 skill-expert-cli，管理中央技能库。
        </p>
        <div className="mt-5 grid grid-cols-2 divide-x divide-border-faint border-y border-border-faint py-3 text-center">
          <div>
            <div className="text-[18px] font-semibold tabular-nums text-primary">{deployed.size}</div>
            <div className="text-[11px] text-muted">当前部署</div>
          </div>
          <div>
            <div className="text-[18px] font-semibold tabular-nums text-primary">0</div>
            <div className="text-[11px] text-muted">待处理</div>
          </div>
        </div>
        <button type="button" className="mt-4 text-[12px] font-medium text-accent hover:text-accent-light">在技能库中查看</button>
      </div>

      <div className="app-panel overflow-hidden">
        <div className="border-b border-border-faint px-4 py-3">
          <h3 className="text-[14px] font-semibold text-primary">部署目标</h3>
          <p className="mt-0.5 text-[12px] text-muted">只显示已经启用、可以获得管理能力的 Agent。</p>
        </div>
        {candidates.map((tool) => {
          const enabled = deployed.has(tool.key);
          return (
            <div key={tool.key} className="flex items-center gap-3 border-b border-border-faint px-4 py-3 last:border-0">
              <AgentIcon agentKey={tool.key} displayName={tool.display_name} className="h-7 w-7 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-primary">{tool.display_name}</div>
                <div className="text-[11px] text-muted">{enabled ? "当前已启用管理能力" : "可启用"}</div>
              </div>
              <AgentToggle enabled={enabled} label={`${enabled ? "关闭" : "开启"} ${tool.display_name} 的管理能力`} onClick={() => toggle(tool.key)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MaintenanceSettings() {
  const [interval, setIntervalValue] = useState("每小时");
  const [applyMode, setApplyMode] = useState("关闭（仅提示）");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="app-section-title mb-2">更新与网络</h3>
        <div className="app-panel divide-y divide-border-faint overflow-hidden">
          <SettingRow title="检查频率" description="后台检查已安装 Skill 是否有来源更新。">
            <SegmentedControl label="检查频率" options={["关闭", "每小时", "每 6 小时", "每天"]} value={interval} onChange={setIntervalValue} />
          </SettingRow>
          <SettingRow title="自动应用更新" description="覆盖中央技能库内容前仍保留清晰边界。">
            <SegmentedControl label="自动应用更新" options={["关闭（仅提示）", "开启"]} value={applyMode} onChange={setApplyMode} />
          </SettingRow>
          <SettingRow title="网络代理" description="所有 Git 拉取和网络请求通过此代理出口。">
            <code className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-secondary">http://127.0.0.1:7890</code>
          </SettingRow>
        </div>
      </div>
      <div>
        <h3 className="app-section-title mb-2">高级</h3>
        <div className="app-panel divide-y divide-border-faint overflow-hidden">
          <SettingRow title="中央仓库路径" description="所有 Skills 和 Preset 配置的默认存储位置。">
            <code className="text-[12px] text-secondary">~/.skill-expert</code>
          </SettingRow>
          <SettingRow title="Git 备份高级配置" description="远程仓库地址与实验性 Git 引擎。">
            <button type="button" className="app-button-secondary px-3 py-2">展开</button>
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
  const [section, setSection] = useState<SectionKey>("preferences");
  return (
    <div className="grid min-h-[620px] overflow-hidden rounded-xl border border-border-subtle bg-surface lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="设置分组" className="border-b border-border-subtle bg-bg-secondary/70 p-3 lg:border-b-0 lg:border-r">
        <div className="px-2 pb-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">设置分组</div>
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
          {attention && <StatusPill tone="attention">需确认</StatusPill>}
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
  const [section, setSection] = useState<SectionKey | null>(null);
  if (section) {
    return (
      <div>
        <button type="button" onClick={() => setSection(null)} className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-secondary">
          <ChevronLeft className="h-3.5 w-3.5" />
          返回设置概览
        </button>
        <ContentHeader section={section} eyebrow="设置概览" />
        <SectionContent section={section} tools={tools} />
      </div>
    );
  }

  const installed = tools.filter((tool) => tool.installed).length;
  const enabled = tools.filter((tool) => tool.installed && tool.enabled).length;
  return (
    <div>
      <div className="mb-5 max-w-[680px]">
        <h2 className="text-[20px] font-semibold tracking-tight text-primary">先看状态，再进入设置</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">每类设置只显示当前结果和是否需要处理，详细选项在下一层。</p>
      </div>
      <div className="app-panel divide-y divide-border-faint overflow-hidden">
        <OverviewRow section="preferences" metric="跟随系统 · 简体中文" detail="默认字号" onClick={() => setSection("preferences")} />
        <OverviewRow section="agents" metric={`已检测 ${installed} · 已启用 ${enabled}`} detail="5 个常用 Agent" onClick={() => setSection("agents")} />
        <OverviewRow section="management" metric="1 个已部署" detail="来源可信 · 0 个待处理" onClick={() => setSection("management")} />
        <OverviewRow section="maintenance" metric="每小时检查" detail="代理已配置 · 备份已连接" attention onClick={() => setSection("maintenance")} />
      </div>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
        <CircleCheck className="h-3.5 w-3.5 text-accent" />
        3 类设置正常，1 类有需要确认的高级选项
      </div>
    </div>
  );
}

const taskTabs: Array<{ key: SectionKey; label: string; helper: string }> = [
  { key: "preferences", label: "日常使用", helper: "外观与窗口" },
  { key: "agents", label: "接入 Agent", helper: "发现与启用" },
  { key: "management", label: "赋予管理能力", helper: "可信部署" },
  { key: "maintenance", label: "维护", helper: "更新与高级" },
];

function VariantC({ tools }: SettingsHierarchyPrototypeProps) {
  const [section, setSection] = useState<SectionKey>("preferences");
  return (
    <div>
      <div role="tablist" aria-label="设置任务" className="mb-6 grid overflow-hidden rounded-xl border border-border-subtle bg-surface sm:grid-cols-2 lg:grid-cols-4">
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
          <ContentHeader section={section} eyebrow="当前任务" />
          <SectionContent section={section} tools={tools} />
        </main>
        <aside className="border-l border-border-faint pl-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">任务边界</div>
          <div className="mt-3 space-y-4 text-[12px] leading-5 text-muted">
            {section === "preferences" && <p>这里只放高频、低风险、立即生效的个人偏好。</p>}
            {section === "agents" && <p>这里只决定哪些 Agent 能接收中央技能库中的 Skills。</p>}
            {section === "management" && <p>这里只决定哪些已启用 Agent 能直接管理中央技能库。</p>}
            {section === "maintenance" && <p>影响来源检查、网络与备份的低频配置集中在这里。</p>}
            <div className="border-t border-border-faint pt-3">
              <div className="flex items-center gap-2 text-secondary">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" />
                不混淆的两个动作
              </div>
              <p className="mt-1">“启用 Agent”不会自动授予“管理 Skills”的能力。</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PrototypeSwitcher({ variant, onChange }: { variant: VariantKey; onChange: (variant: VariantKey) => void }) {
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
      <button type="button" onClick={() => move(-1)} aria-label="上一个方案" className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-400">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div aria-live="polite" className="min-w-[150px] px-3 text-center text-[12px] font-medium">
        {variant} · {variantNames[variant]}
      </div>
      <button type="button" onClick={() => move(1)} aria-label="下一个方案" className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-400">
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export function SettingsHierarchyPrototype({ tools }: SettingsHierarchyPrototypeProps) {
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
          设置
        </h1>
        <p className="app-page-subtitle">比较 Agent 接入、Agent Skills 管理能力与普通全局偏好的信息分层。</p>
      </div>
      <PrototypeNotice />
      {variant === "A" && <VariantA tools={tools} />}
      {variant === "B" && <VariantB tools={tools} />}
      {variant === "C" && <VariantC tools={tools} />}
      <PrototypeSwitcher variant={variant} onChange={changeVariant} />
    </div>
  );
}
