import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  CircleOff,
  Cloud,
  Download,
  ExternalLink,
  Folder,
  LayoutDashboard,
  Library,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import {
  PrototypeSwitcher,
  type PrototypeVariant,
} from "../../components/prototypes/PrototypeSwitcher";

// 可丢弃原型：现有 /settings 页面中的三种 Agent Skills 管理模块，通过 ?variant= 切换。

type Scenario = "normal" | "conflict" | "partial";
type AgentScale = "compact" | "many";

interface AgentOption {
  key: string;
  name: string;
  icon: string;
  path: string;
  active: boolean;
  residual?: boolean;
}

interface VariantProps {
  agents: AgentOption[];
  currentTargets: Set<string>;
  draftTargets: Set<string>;
  scenario: Scenario;
  additions: AgentOption[];
  removals: AgentOption[];
  lastResult: string | null;
  toggle: (key: string) => void;
  requestApply: () => void;
  resetDraft: () => void;
}

const AGENT_POOL: AgentOption[] = [
  {
    key: "codex",
    name: "Codex",
    icon: "/agent-icons/codex.svg",
    path: "~/.codex/skills",
    active: true,
  },
  {
    key: "claude_code",
    name: "Claude Code",
    icon: "/agent-icons/claude_code.svg",
    path: "~/.claude/skills",
    active: true,
  },
  {
    key: "warp",
    name: "Warp",
    icon: "/agent-icons/warp.svg",
    path: "~/.warp/skills",
    active: true,
  },
  {
    key: "workbuddy",
    name: "WorkBuddy",
    icon: "/agent-icons/workbuddy.png",
    path: "~/.workbuddy/skills",
    active: false,
    residual: true,
  },
  {
    key: "cursor",
    name: "Cursor",
    icon: "/agent-icons/cursor.png",
    path: "~/.cursor/skills",
    active: true,
  },
  {
    key: "gemini_cli",
    name: "Gemini CLI",
    icon: "/agent-icons/gemini_cli.svg",
    path: "~/.gemini/skills",
    active: true,
  },
  {
    key: "kimi",
    name: "Kimi Code",
    icon: "/agent-icons/kimi.svg",
    path: "~/.kimi/skills",
    active: true,
  },
  {
    key: "opencode",
    name: "OpenCode",
    icon: "/agent-icons/opencode.png",
    path: "~/.config/opencode/skills",
    active: true,
  },
  {
    key: "github_copilot",
    name: "GitHub Copilot",
    icon: "/agent-icons/github_copilot.png",
    path: "~/.copilot/skills",
    active: true,
  },
  {
    key: "cline",
    name: "Cline",
    icon: "/agent-icons/cline.png",
    path: "~/.cline/skills",
    active: true,
  },
  {
    key: "qwen_code",
    name: "Qwen Code",
    icon: "/agent-icons/qwen_code.png",
    path: "~/.qwen/skills",
    active: true,
  },
  {
    key: "windsurf",
    name: "Windsurf",
    icon: "/agent-icons/windsurf.svg",
    path: "~/.codeium/windsurf/skills",
    active: true,
  },
  {
    key: "deepseek_harness",
    name: "DeepSeek Harness",
    icon: "/agent-icons/deepseek_harness.svg",
    path: "~/.deepseek/skills",
    active: true,
  },
  {
    key: "replit",
    name: "Replit",
    icon: "/agent-icons/replit.png",
    path: "~/.replit/skills",
    active: true,
  },
];

const VARIANTS: PrototypeVariant[] = [
  { key: "A", name: "紧凑状态矩阵" },
  { key: "B", name: "任务式配置" },
  { key: "C", name: "双栏控制中心" },
];

const INITIAL_TARGETS = ["codex", "claude_code", "workbuddy"];
const MANY_INITIAL_TARGETS = ["codex", "claude_code", "workbuddy", "cursor", "kimi"];

function AgentMark({ agent, size = "md" }: { agent: AgentOption; size?: "sm" | "md" }) {
  const dimension = size === "sm" ? "h-7 w-7 rounded-lg" : "h-9 w-9 rounded-xl";
  return (
    <span
      className={`${dimension} grid shrink-0 place-items-center border border-border-subtle bg-bg-secondary`}
    >
      <img src={agent.icon} alt="" className="h-5 w-5 object-contain" />
    </span>
  );
}

function SelectionToggle({
  selected,
  disabled,
  onClick,
  label,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-10 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? "border-accent bg-accent"
          : "border-border bg-surface-active"
      }`}
    >
      <span
        className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
          selected ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function ChangeSummary({ additions, removals }: Pick<VariantProps, "additions" | "removals">) {
  if (additions.length === 0 && removals.length === 0) {
    return <span className="text-[12px] text-muted">没有待应用的更改</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      {additions.map((agent) => (
        <span
          key={`add-${agent.key}`}
          className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700"
        >
          + {agent.name}
        </span>
      ))}
      {removals.map((agent) => (
        <span
          key={`remove-${agent.key}`}
          className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700"
        >
          − {agent.name}
        </span>
      ))}
    </div>
  );
}

function SourceStatus({ scenario, compact = false }: { scenario: Scenario; compact?: boolean }) {
  const conflict = scenario === "conflict";
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border ${compact ? "p-2.5" : "p-3"} ${
        conflict
          ? "border-amber-500/30 bg-amber-500/[0.08]"
          : "border-emerald-500/20 bg-emerald-500/[0.06]"
      }`}
    >
      {conflict ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      )}
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-secondary">
          {conflict ? "发现同名异源 Skill" : "可信管理 Skill 已验证"}
        </p>
        {!compact && (
          <p className="mt-0.5 text-[11px] leading-4 text-muted">
            {conflict
              ? "当前 manage-skills 不是来自固定可信来源，应用更改已暂停。"
              : "来源为 Alex-Shen1121/skill-expert，可安全调整部署目标。"}
          </p>
        )}
      </div>
    </div>
  );
}

function ApplyButton({
  scenario,
  additions,
  removals,
  onClick,
  compact = false,
}: Pick<VariantProps, "scenario" | "additions" | "removals"> & {
  onClick: () => void;
  compact?: boolean;
}) {
  const changed = additions.length > 0 || removals.length > 0;
  return (
    <button
      type="button"
      disabled={!changed || scenario === "conflict"}
      onClick={onClick}
      className={`app-button-primary ${compact ? "px-3 py-2" : ""}`}
    >
      <Check className="h-3.5 w-3.5" />
      {scenario === "conflict" ? "先处理来源冲突" : "应用更改"}
    </button>
  );
}

function VariantA(props: VariantProps) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="app-section-title">Agent 管理 Skills</h2>
          <p className="mt-1 text-[12px] text-muted">集中查看并调整每个 Agent 的管理能力。</p>
        </div>
        <button type="button" className="text-[12px] font-medium text-accent hover:text-accent-light">
          在技能库中查看
        </button>
      </div>

      <div className="app-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-bg text-accent">
              <Terminal className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-primary">manage-skills</p>
              <p className="text-[11px] text-muted">{props.currentTargets.size} 个 Agent 已部署</p>
            </div>
          </div>
          <SourceStatus scenario={props.scenario} compact />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_140px_84px] border-b border-border-faint bg-bg-secondary px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
          <span>Agent</span>
          <span>当前状态</span>
          <span className="text-right">管理能力</span>
        </div>
        {props.agents.map((agent) => {
          const selected = props.draftTargets.has(agent.key);
          const current = props.currentTargets.has(agent.key);
          return (
            <div
              key={agent.key}
              className="grid grid-cols-[minmax(0,1fr)_140px_84px] items-center border-b border-border-faint px-4 py-3 last:border-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <AgentMark agent={agent} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-secondary">{agent.name}</p>
                  <p className="truncate font-mono text-[10px] text-faint">{agent.path}</p>
                </div>
              </div>
              <div>
                {!agent.active ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    <CircleOff className="h-3 w-3" /> 残留部署
                  </span>
                ) : current ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> 已启用
                  </span>
                ) : (
                  <span className="text-[11px] text-muted">未启用</span>
                )}
              </div>
              <div className="flex justify-end">
                <SelectionToggle
                  selected={selected}
                  disabled={props.scenario === "conflict"}
                  onClick={() => props.toggle(agent.key)}
                  label={`${selected ? "关闭" : "开启"} ${agent.name} 的管理能力`}
                />
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-3 bg-bg-secondary px-4 py-3">
          <ChangeSummary additions={props.additions} removals={props.removals} />
          <div className="flex items-center gap-2">
            {(props.additions.length > 0 || props.removals.length > 0) && (
              <button type="button" onClick={props.resetDraft} className="app-button-secondary px-3 py-2">
                <RotateCcw className="h-3.5 w-3.5" /> 撤销草稿
              </button>
            )}
            <ApplyButton {...props} onClick={props.requestApply} compact />
          </div>
        </div>
      </div>
      {props.lastResult && (
        <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700">
          {props.lastResult}
        </p>
      )}
    </section>
  );
}

function VariantB(props: VariantProps) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="app-section-title">Agent 管理 Skills</h2>
        <p className="mt-1 text-[12px] text-muted">按步骤检查来源、选择目标，然后统一应用。</p>
      </div>

      <div className="app-panel overflow-hidden">
        <div className="grid grid-cols-[44px_minmax(0,1fr)] border-b border-border-faint">
          <div className="grid place-items-start border-r border-border-faint bg-bg-secondary py-4">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold ${props.scenario === "conflict" ? "bg-amber-500/15 text-amber-700" : "bg-emerald-500/15 text-emerald-700"}`}>
              1
            </span>
          </div>
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-primary">确认管理 Skill</h3>
                <p className="mt-0.5 text-[11px] text-muted">先确认来源可信，再调整 Agent。</p>
              </div>
              <button type="button" className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                查看 Skill <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <SourceStatus scenario={props.scenario} />
          </div>
        </div>

        <div className="grid grid-cols-[44px_minmax(0,1fr)] border-b border-border-faint">
          <div className="grid place-items-start border-r border-border-faint bg-bg-secondary py-4">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-bg text-[12px] font-bold text-accent">2</span>
          </div>
          <div className="p-4">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-primary">选择管理目标</h3>
                <p className="mt-0.5 text-[11px] text-muted">停用 Agent 的残留部署也会保留在这里。</p>
              </div>
              <span className="text-[11px] tabular-nums text-muted">已选 {props.draftTargets.size}</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {props.agents.map((agent) => {
                const selected = props.draftTargets.has(agent.key);
                return (
                  <button
                    type="button"
                    key={agent.key}
                    disabled={props.scenario === "conflict"}
                    onClick={() => props.toggle(agent.key)}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${
                      selected
                        ? "border-accent-border bg-accent-bg shadow-[inset_0_0_0_1px_var(--color-accent-border)]"
                        : "border-border-subtle bg-surface hover:bg-surface-hover"
                    }`}
                  >
                    <AgentMark agent={agent} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[13px] font-semibold text-secondary">{agent.name}</p>
                        {!agent.active && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">已停用</span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[10px] text-muted">
                        {selected ? "将保留管理能力" : "不会部署管理能力"}
                      </p>
                    </div>
                    <span className={`grid h-5 w-5 place-items-center rounded-md border ${selected ? "border-accent bg-accent text-white" : "border-border bg-white"}`}>
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-[44px_minmax(0,1fr)]">
          <div className="grid place-items-start border-r border-border-faint bg-bg-secondary py-4">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-zinc-500/10 text-[12px] font-bold text-muted">3</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h3 className="text-[13px] font-semibold text-primary">复核并应用</h3>
              <div className="mt-1.5"><ChangeSummary additions={props.additions} removals={props.removals} /></div>
              {props.lastResult && <p className="mt-1.5 text-[11px] text-amber-700">{props.lastResult}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={props.resetDraft} className="app-button-secondary px-3 py-2">
                重置
              </button>
              <ApplyButton {...props} onClick={props.requestApply} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function VariantC(props: VariantProps) {
  const [query, setQuery] = useState("");
  const [targetFilter, setTargetFilter] = useState<"all" | "deployed" | "available" | "attention">("all");
  const attentionCount = props.agents.filter(
    (agent) => !agent.active && props.currentTargets.has(agent.key),
  ).length;
  const filteredAgents = props.agents.filter((agent) => {
    const matchesQuery = agent.name.toLowerCase().includes(query.trim().toLowerCase());
    if (!matchesQuery) return false;
    if (targetFilter === "deployed") return props.draftTargets.has(agent.key);
    if (targetFilter === "available") return agent.active && !props.draftTargets.has(agent.key);
    if (targetFilter === "attention") return !agent.active && props.currentTargets.has(agent.key);
    return true;
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="app-section-title">Agent 管理 Skills</h2>
          <p className="mt-1 text-[12px] text-muted">把管理 Skill 与部署目标分开查看。</p>
        </div>
        <span className="rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-muted">
          {props.currentTargets.size} 个已部署
        </span>
      </div>

      <div className="grid grid-cols-[0.86fr_1.4fr] gap-3">
        <div className="relative overflow-hidden rounded-2xl border border-accent-border bg-[linear-gradient(145deg,#f0fdf7_0%,#ffffff_56%,#ecfdf5_100%)] p-4 shadow-[0_12px_30px_rgba(5,150,105,0.08)]">
          <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-emerald-300/25 blur-2xl" />
          <div className="absolute inset-x-0 bottom-0 h-24 bg-[radial-gradient(circle_at_1px_1px,rgba(5,150,105,0.12)_1px,transparent_0)] bg-[size:12px_12px] [mask-image:linear-gradient(to_top,black,transparent)]" />
          <div className="relative">
            <div className="mb-8 flex items-center justify-between">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent-border bg-white/80 text-accent shadow-sm">
                <Sparkles className="h-4 w-4" />
              </span>
              <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${props.scenario === "conflict" ? "border-amber-500/25 bg-amber-500/10 text-amber-700" : "border-emerald-500/20 bg-white/75 text-emerald-700"}`}>
                {props.scenario === "conflict" ? "来源冲突" : "来源可信"}
              </span>
            </div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-emerald-700/60">管理 Skill</p>
            <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-primary">manage-skills</h3>
            <p className="mt-2 text-[11px] leading-5 text-muted">
              {props.scenario === "conflict"
                ? "检测到同名但来源不同的 Skill。为保护现有内容，所有部署操作已锁定。"
                : "已验证固定来源。Agent 通过它调用 skill-expert-cli 管理中央技能库。"}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-emerald-500/15 bg-white/70 p-3 shadow-sm shadow-emerald-900/[0.03]">
                <p className="text-[10px] text-muted">当前部署</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-primary">{props.currentTargets.size}</p>
              </div>
              <div className="rounded-xl border border-emerald-500/15 bg-white/70 p-3 shadow-sm shadow-emerald-900/[0.03]">
                <p className="text-[10px] text-muted">待处理</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-primary">{props.additions.length + props.removals.length}</p>
              </div>
            </div>
            <button type="button" className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent hover:text-accent-dark">
              在技能库中查看 <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="app-panel flex h-[410px] min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border-faint px-4 pb-2.5 pt-3">
            <div className="mb-2.5 flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold text-primary">部署目标</h3>
                <p className="mt-0.5 text-[10px] text-muted">选择可以直接管理 Skills 的 Agent</p>
              </div>
              <SlidersHorizontal className="h-4 w-4 text-faint" />
            </div>
            <label className="flex h-8 items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-2.5 focus-within:border-border">
              <Search className="h-3.5 w-3.5 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`搜索 ${props.agents.length} 个 Agent`}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-secondary outline-none placeholder:text-faint"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label="清空 Agent 搜索">
                  <X className="h-3 w-3 text-faint" />
                </button>
              )}
            </label>
            <div className="mt-2 flex items-center gap-1 overflow-x-auto scrollbar-hide">
              {([
                ["all", `全部 ${props.agents.length}`],
                ["deployed", `已部署 ${props.draftTargets.size}`],
                ["available", `可启用 ${props.agents.filter((agent) => agent.active && !props.draftTargets.has(agent.key)).length}`],
                ["attention", `需处理 ${attentionCount}`],
              ] as const).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setTargetFilter(key)}
                  className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium transition ${
                    targetFilter === key
                      ? key === "attention" && attentionCount > 0
                        ? "bg-amber-500/10 text-amber-700"
                        : "bg-surface-active text-secondary"
                      : "text-muted hover:bg-surface-hover hover:text-secondary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-border-faint overflow-y-auto overscroll-contain scrollbar-hide">
            {filteredAgents.map((agent) => {
              const selected = props.draftTargets.has(agent.key);
              const current = props.currentTargets.has(agent.key);
              return (
                <div key={agent.key} className="flex items-center gap-3 px-4 py-2.5">
                  <AgentMark agent={agent} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[12px] font-semibold text-secondary">{agent.name}</p>
                      {!agent.active && <CircleOff className="h-3 w-3 text-amber-600" />}
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      {!agent.active ? "Agent 已停用，仍保留部署记录" : current ? "当前已启用管理能力" : "当前未启用"}
                    </p>
                  </div>
                  <SelectionToggle
                    selected={selected}
                    disabled={props.scenario === "conflict"}
                    onClick={() => props.toggle(agent.key)}
                    label={`${selected ? "关闭" : "开启"} ${agent.name} 的管理能力`}
                  />
                </div>
              );
            })}
            {filteredAgents.length === 0 && (
              <div className="grid h-full min-h-24 place-items-center px-4 text-center">
                <p className="text-[11px] text-muted">没有符合当前搜索与筛选条件的 Agent</p>
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-border-faint bg-bg-secondary p-3 shadow-[0_-8px_18px_rgba(24,24,27,0.03)]">
            <div className="mb-2.5 min-h-6"><ChangeSummary additions={props.additions} removals={props.removals} /></div>
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={props.resetDraft} className="text-[11px] font-medium text-muted hover:text-secondary">
                放弃更改
              </button>
              <ApplyButton {...props} onClick={props.requestApply} compact />
            </div>
            {props.lastResult && <p className="mt-2 text-[10px] text-amber-700">{props.lastResult}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function PrototypeSidebar() {
  const primary = [
    { label: "Dashboard", icon: LayoutDashboard },
    { label: "技能库", icon: Library },
    { label: "安装 Skills", icon: Download },
    { label: "备份", icon: Cloud },
  ];
  return (
    <aside className="flex w-[196px] shrink-0 flex-col border-r border-border-subtle bg-bg-secondary px-3 pb-3 pt-9">
      <div className="mb-5 flex items-center gap-2 px-1.5">
        <img src="/icons/32x32.png" alt="" className="h-6 w-6 rounded-lg" />
        <span className="text-[14px] font-semibold text-primary">Agent 技能管家</span>
      </div>
      <nav className="space-y-1">
        {primary.map((item) => (
          <button key={item.label} type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-muted hover:bg-surface-active">
            <item.icon className="h-3.5 w-3.5" /> {item.label}
          </button>
        ))}
      </nav>
      <div className="my-3 border-t border-border-faint" />
      <p className="mb-1.5 px-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-faint">全局工作区</p>
      {["全部 Agents", "Claude Code 36", "Codex 93", "Warp 51"].map((item) => (
        <button key={item} type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-muted hover:bg-surface-active">
          <Bot className="h-3.5 w-3.5" /> {item}
        </button>
      ))}
      <div className="mt-auto">
        <button type="button" className="flex w-full items-center gap-2 rounded-lg bg-surface-active px-2.5 py-2 text-left text-[12px] font-semibold text-secondary">
          <Settings2 className="h-3.5 w-3.5 text-accent" /> 设置
        </button>
      </div>
    </aside>
  );
}

function ContextAgentSection() {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <div>
          <h2 className="app-section-title">支持的 Agent（5/42）</h2>
          <p className="mt-1 text-[11px] text-muted">已检测 5 · 已启用 5 · 自定义 0</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-medium text-accent">
          <span>+ 添加自定义 Agent</span>
          <span>刷新</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {AGENT_POOL.slice(0, 3).map((agent) => (
          <div key={agent.key} className="app-panel flex items-center gap-2.5 px-3 py-2.5">
            <AgentMark agent={agent} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold text-secondary">{agent.name}</p>
              <p className="truncate text-[9px] text-muted">已检测 · 已启用</p>
            </div>
            <span className="h-4 w-7 rounded-full bg-accent p-0.5"><span className="ml-auto block h-3 w-3 rounded-full bg-white" /></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ContextGlobalSection() {
  return (
    <section className="pb-24">
      <h2 className="app-section-title mb-3">全局配置</h2>
      <div className="app-panel divide-y divide-border-faint overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Folder className="h-4 w-4 text-faint" />
            <div><p className="text-[12px] font-semibold text-secondary">中央技能库位置</p><p className="text-[10px] text-muted">~/.skill-expert</p></div>
          </div>
          <button type="button" className="app-button-secondary px-3 py-1.5 text-[11px]">更改目录</button>
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <RefreshCw className="h-4 w-4 text-faint" />
            <div><p className="text-[12px] font-semibold text-secondary">同步模式</p><p className="text-[10px] text-muted">使用符号链接部署 Skills</p></div>
          </div>
          <span className="rounded-lg border border-border-subtle bg-surface-active px-3 py-1.5 text-[11px] font-medium">符号链接</span>
        </div>
      </div>
    </section>
  );
}

export function AgentSkillsSettingsPrototype() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedVariant = searchParams.get("variant") ?? "A";
  const variant = VARIANTS.some((item) => item.key === requestedVariant) ? requestedVariant : "A";
  const [scenario, setScenarioState] = useState<Scenario>("normal");
  const [agentScale, setAgentScaleState] = useState<AgentScale>("compact");
  const [currentTargets, setCurrentTargets] = useState(() => new Set(INITIAL_TARGETS));
  const [draftTargets, setDraftTargets] = useState(() => new Set(INITIAL_TARGETS));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const agents = useMemo(
    () => (agentScale === "many" ? AGENT_POOL : AGENT_POOL.slice(0, 4)),
    [agentScale],
  );
  const additions = useMemo(
    () => agents.filter((agent) => draftTargets.has(agent.key) && !currentTargets.has(agent.key)),
    [agents, currentTargets, draftTargets],
  );
  const removals = useMemo(
    () => agents.filter((agent) => currentTargets.has(agent.key) && !draftTargets.has(agent.key)),
    [agents, currentTargets, draftTargets],
  );

  const toggle = (key: string) => {
    setLastResult(null);
    setDraftTargets((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resetDraft = () => {
    setDraftTargets(new Set(currentTargets));
    setLastResult(null);
  };

  const apply = () => {
    setConfirmOpen(false);
    if (scenario === "conflict") return;
    if (scenario === "partial") {
      const next = new Set(draftTargets);
      if (currentTargets.has("warp")) next.add("warp");
      else next.delete("warp");
      setCurrentTargets(next);
      setLastResult("Codex、Claude Code 与 WorkBuddy 已同步；Warp 写入失败，可保留草稿后重试。");
      return;
    }
    setCurrentTargets(new Set(draftTargets));
    setLastResult("更改已应用，当前部署状态已刷新。");
  };

  const requestApply = () => {
    if (removals.length > 0) setConfirmOpen(true);
    else apply();
  };

  const setScenario = (next: Scenario) => {
    setScenarioState(next);
    setLastResult(null);
  };

  const setAgentScale = (next: AgentScale) => {
    const targets = next === "many" ? MANY_INITIAL_TARGETS : INITIAL_TARGETS;
    setAgentScaleState(next);
    setCurrentTargets(new Set(targets));
    setDraftTargets(new Set(targets));
    setLastResult(null);
  };

  const commonProps: VariantProps = {
    agents,
    currentTargets,
    draftTargets,
    scenario,
    additions,
    removals,
    lastResult,
    toggle,
    requestApply,
    resetDraft,
  };

  return (
    <div className="flex h-full min-w-[960px] overflow-hidden bg-background text-primary">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-7 border-b border-border-subtle bg-bg-secondary" />
      <PrototypeSidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-5 pb-8 pt-12 scrollbar-hide">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-6">
          <header className="flex items-end justify-between border-b border-border-subtle pb-4">
            <div>
              <h1 className="app-page-title flex items-center gap-2"><Settings2 className="h-4 w-4 text-accent" /> 设置</h1>
              <p className="mt-1 text-[11px] text-muted">原型问题：永久 Agent 管理模块怎样放进现有设置页最自然？</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface p-1">
                <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">规模</span>
                {([[
                  "compact",
                  "4 个",
                ], [
                  "many",
                  `${AGENT_POOL.length} 个`,
                ]] as const).map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => setAgentScale(key)}
                    className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition ${agentScale === key ? "bg-surface-active text-secondary" : "text-muted hover:text-secondary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface p-1">
                <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">场景</span>
                {([
                  ["normal", "正常"],
                  ["conflict", "来源冲突"],
                  ["partial", "部分失败"],
                ] as const).map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => setScenario(key)}
                    className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition ${scenario === key ? "bg-surface-active text-secondary" : "text-muted hover:text-secondary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <ContextAgentSection />
          {variant === "A" && <VariantA {...commonProps} />}
          {variant === "B" && <VariantB {...commonProps} />}
          {variant === "C" && <VariantC {...commonProps} />}
          <ContextGlobalSection />
        </div>
      </main>

      <aside className="fixed bottom-5 right-5 z-[90] w-[244px] rounded-xl border border-border-subtle bg-surface/95 p-3 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"><Search className="h-3 w-3" /> 完整原型状态</span>
          <button type="button" onClick={resetDraft} aria-label="重置原型状态"><X className="h-3 w-3 text-faint" /></button>
        </div>
        <dl className="grid grid-cols-[58px_1fr] gap-x-2 gap-y-1 text-[10px] leading-4">
          <dt className="text-faint">方案</dt><dd className="font-medium text-secondary">{variant} · {VARIANTS.find((item) => item.key === variant)?.name}</dd>
          <dt className="text-faint">规模</dt><dd className="text-secondary">{agents.length} 个 Agent</dd>
          <dt className="text-faint">场景</dt><dd className="text-secondary">{scenario === "normal" ? "正常" : scenario === "conflict" ? "来源冲突" : "部分失败"}</dd>
          <dt className="text-faint">真实部署</dt><dd className="text-secondary">{agents.filter((agent) => currentTargets.has(agent.key)).map((agent) => agent.name).join("、") || "无"}</dd>
          <dt className="text-faint">草稿目标</dt><dd className="text-secondary">{agents.filter((agent) => draftTargets.has(agent.key)).map((agent) => agent.name).join("、") || "无"}</dd>
          <dt className="text-faint">待应用</dt><dd><ChangeSummary additions={additions} removals={removals} /></dd>
        </dl>
      </aside>

      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onChange={(key) => {
          const next = new URLSearchParams(searchParams);
          next.set("variant", key);
          setSearchParams(next, { replace: true });
        }}
      />

      {confirmOpen && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-zinc-950/35 p-6 backdrop-blur-[2px]">
          <div className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 shadow-2xl">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/10 text-amber-700"><AlertTriangle className="h-5 w-5" /></span>
            <h2 className="mt-4 text-[16px] font-semibold text-primary">确认撤销管理能力</h2>
            <p className="mt-2 text-[12px] leading-5 text-muted">
              将从 {removals.map((agent) => agent.name).join("、")} 撤销 manage-skills 部署。中央技能库中的 Skill 会继续保留。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="app-button-secondary">取消</button>
              <button type="button" onClick={apply} className="inline-flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-600 px-4 py-2.5 text-[13px] font-medium text-white hover:bg-amber-700">
                确认撤销并应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
