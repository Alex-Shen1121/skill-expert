// 一次性原型：在现有 /my-skills 路由通过 ?variant=A|B|C 比较三种左树右预览布局。
// 用户已选择 B 为基线；本轮调整技能信息的层级，并补回差异和来源模块。A/C 保留为历史对照。
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ChevronsDownUp, Code2, File, FileText, Folder, FolderOpen, Image, Link2, PanelLeftClose, PanelLeftOpen, Search, LockKeyhole, Sun, Moon, ArrowLeft, Info, Layers, HardDrive, Check, BookOpen, GitCompareArrows, History } from "lucide-react";
import { SkillMarkdown } from "./SkillMarkdown";
import { SkillSourceDiffViewer } from "./SkillSourceDiffViewer";
import { AgentIcon } from "./AgentIcon";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { exampleEntries, exampleSourceEntries, exampleDiff, type ExampleEntry } from "./SkillFiles.prototype.data";
import type { ManagedSkill } from "../lib/tauri";
import "./SkillFiles.prototype.css";

const names: Record<string, string> = { A: "完整介绍", B: "紧凑工作台", C: "独立信息栏" };
const fileCount = exampleEntries.filter(entry => entry.kind !== "directory").length;
const directoryCount = exampleEntries.length - fileCount;
const localFiles = new Map(exampleEntries.map(entry => [entry.path, entry]));
const sourceFiles = new Map(exampleSourceEntries.map(entry => [entry.path, entry]));
const diffFiles = new Map(exampleDiff.map(entry => [entry.relative_path, entry]));
const allEntries = [...new Map([...exampleEntries, ...exampleSourceEntries].map(entry => [entry.path, entry])).values()];
const comparisonLabels = { modified: "修改", added: "新增", removed: "删除", unchanged: "未变化", excluded: "不比较", unavailable: "无法比较" };

function comparisonStatus(path: string): keyof typeof comparisonLabels {
  const item = localFiles.get(path) ?? sourceFiles.get(path);
  if (item?.kind === "symlink" || path.split("/").some(part => [".git", ".gitignore", ".DS_Store", "Thumbs.db", "__pycache__"].includes(part) || part.endsWith(".pyc"))) return "excluded";
  if (item?.kind === "unreadable") return "unavailable";
  return diffFiles.get(path)?.status ?? "unchanged";
}

function EntryIcon({ entry }: { entry: ExampleEntry }) {
  const Icon = entry.kind === "directory" ? Folder : entry.kind === "symlink" ? Link2 : entry.path.endsWith(".md") ? FileText : entry.path.endsWith(".png") ? Image : /\.(py|json)$/.test(entry.path) ? Code2 : File;
  return <Icon size={15} className={entry.path === "SKILL.md" ? "sf-accent" : ""} />;
}

function FileContents({ entry, path, raw, side }: { entry?: ExampleEntry; path: string; raw: boolean; side: string }) {
  if (!entry) return <div className="sf-file-message"><div className="sf-file-message-icon"><File size={27} /></div><h2>此版本中没有该文件</h2><p>{side}中不存在 {path}。</p></div>;
  if (entry.kind === "text") return entry.path.endsWith(".md") && !raw
    ? <div className="sf-document"><SkillMarkdown content={entry.body ?? ""} /></div>
    : <div className="sf-code"><pre aria-label={`${side}文件原文`}>{entry.body?.split("\n").map((line, index) => <div className="sf-code-line" key={index}><span aria-hidden="true">{index + 1}</span><code>{line || " "}</code></div>)}</pre></div>;
  return <div className="sf-file-message"><div className="sf-file-message-icon"><EntryIcon entry={entry} /></div><h2>{entry.path.split("/").pop()}</h2><p>{entry.note}</p><span>{entry.size} · {entry.kind === "symlink" ? "符号链接" : entry.kind === "unreadable" ? "无法读取" : entry.kind === "large" ? "超大文件" : "二进制文件"}</span></div>;
}

export function VariantA({ header, tree, reader }: { header: ReactNode; tree: ReactNode; reader: ReactNode }) {
  return <div className="sf-variant sf-a">{header}<div className="sf-a-caption"><span>技能文件 <small>{fileCount} 个文件 · {directoryCount} 个目录</small></span><span>当前安装版本 · 只读</span></div><div className="sf-a-frame">{tree}{reader}</div></div>;
}

export function VariantB({ header, tree, reader }: { header: ReactNode; tree: ReactNode; reader: ReactNode }) {
  return <div className="sf-variant sf-b">{header}<div className="sf-b-workbench">{tree}{reader}</div></div>;
}

export function VariantC({ header, info, tree, reader }: { header: ReactNode; info: ReactNode; tree: ReactNode; reader: ReactNode }) {
  return <div className="sf-variant sf-c">{header}<div className="sf-c-columns"><aside className="sf-context">{info}</aside>{tree}{reader}</div></div>;
}

export function SkillFilesPrototype({ skill }: { skill: ManagedSkill }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("variant") ?? "B";
  const variant = names[requested] ? requested : "B";
  const [selected, setSelected] = useState("SKILL.md");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(true);
  const [showState, setShowState] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(params.get("info") === "open");
  const contentTab = variant !== "B" ? "local" : params.get("view") === "diff" ? "diff" : params.get("view") === "source" ? "source" : "local";
  const setContentTab = (view: "local" | "diff" | "source") => setParams(previous => { previous.set("view", view); return previous; }, { replace: true });
  const [diffOnly, setDiffOnly] = useState(false);
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const entries = contentTab === "local" ? exampleEntries : contentTab === "source" ? exampleSourceEntries : allEntries;
  const entry = (contentTab === "source" ? sourceFiles : localFiles).get(selected);
  const selectedIconEntry = localFiles.get(selected) ?? sourceFiles.get(selected)!;
  const isMarkdown = selected.endsWith(".md");
  const matches = entries.filter(item => item.path.toLowerCase().includes(query.toLowerCase()));
  const activeFileCount = entries.filter(item => item.kind !== "directory").length;
  const selectedChange = diffFiles.get(selected);
  const status = comparisonStatus(selected);
  const state = { "方案": variant, "已选基线": "B", "内容模块": contentTab, "技能信息展开": metadataOpen, "选中文件": selected, "比较状态": status, "差异只看变化片段": diffOnly, "展开目录": expanded, "目录可见": treeVisible, "过滤词": query, "预览模式": raw ? "原文" : "正文", "条目类型": entry?.kind ?? "此版本缺失", "文件总数": activeFileCount, "弹层打开": open };
  useEffect(() => { console.info("技能文件原型状态", { variant, selected, expanded, treeVisible, query, raw, open, contentTab, metadataOpen, diffOnly }); }, [variant, selected, expanded, treeVisible, query, raw, open, contentTab, metadataOpen, diffOnly]);

  const choose = (path: string) => { setSelected(path); setRaw(false); };
  const toggleDirectory = (path: string) => {
    if (query) {
      const parts = path.split("/");
      setExpanded(current => [...new Set([...current, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))])]);
      setQuery("");
    } else setExpanded(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path]);
  };
  const childrenOf = (parent: string) => entries.filter(item => item.path.split("/").slice(0, -1).join("/") === parent);
  const renderEntries = (items: ExampleEntry[], depth = 0): ReactNode => <ul>
    {items.map(item => <li key={item.path}>
      <button className={`sf-file-row ${selected === item.path ? "sf-file-selected" : ""}`} style={{ paddingLeft: 12 + depth * 15 }}
        title={item.path} aria-label={item.path} aria-current={selected === item.path ? "true" : undefined} aria-description={contentTab === "diff" && item.kind !== "directory" ? comparisonLabels[comparisonStatus(item.path)] : undefined}
        aria-expanded={item.kind === "directory" ? expanded.includes(item.path) || !!query : undefined}
        onClick={() => item.kind === "directory" ? toggleDirectory(item.path) : choose(item.path)}>
        {item.kind === "directory" ? (expanded.includes(item.path) || query ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="sf-tree-spacer" />}
        <EntryIcon entry={item} /><span>{query ? item.path : item.path.split("/").pop()}</span>
        {contentTab === "diff" && item.kind !== "directory" ? <small className={`sf-change-${comparisonStatus(item.path)}`}>{comparisonLabels[comparisonStatus(item.path)]}</small> : <>{item.path === "SKILL.md" && <small>入口</small>}{item.kind === "symlink" && <small>链接</small>}</>}
      </button>
      {!query && item.kind === "directory" && expanded.includes(item.path) && (childrenOf(item.path).length ? renderEntries(childrenOf(item.path), depth + 1) : <div className="sf-empty-folder" style={{ paddingLeft: 42 + depth * 15 }}>空目录</div>)}
    </li>)}
  </ul>;

  const tree = treeVisible && <nav className="sf-tree" aria-label={`${contentTab === "local" ? "本地" : contentTab === "source" ? "来源" : "差异"}完整文件目录`}>
    <div className="sf-tree-heading"><span><FolderOpen size={15} />{contentTab === "source" ? "来源文件" : contentTab === "diff" ? "两边全部文件" : "全部文件"}</span><button title="折叠所有目录" aria-label="折叠所有目录" onClick={() => setExpanded([])}><ChevronsDownUp size={15} /></button></div>
    <label className="sf-search"><Search size={14} /><input aria-label="查找文件" placeholder="查找文件…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清除文件查找" onClick={() => setQuery("")}>×</button>}</label>
    <div className="sf-file-list">{renderEntries(query ? matches : childrenOf(""))}{query && matches.length === 0 && <p className="sf-empty-folder">没有匹配的文件</p>}</div>
    <div className="sf-tree-footer">{query ? `${matches.length} 个匹配项` : `${activeFileCount} 个文件 · ${entries.length - activeFileCount} 个目录`}<span>{contentTab === "diff" ? `${exampleDiff.length} 个变化文件 · 其余条目仍可查看` : "包含隐藏项与缓存"}</span></div>
  </nav>;

  const treeToggle = <button className="sf-icon-button" aria-label={treeVisible ? "收起目录树" : "展开目录树"} title={treeVisible ? "收起目录树" : "展开目录树"} onClick={() => setTreeVisible(!treeVisible)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>;
  const reader = <section className="sf-reader" aria-label={contentTab === "source" ? "来源文件只读预览" : "本地文件只读预览"}>
    <div className="sf-reader-toolbar">
      {treeToggle}
      <div className="sf-file-path" title={selected}><EntryIcon entry={selectedIconEntry} /><span>{selected}</span></div>
      {isMarkdown && <div className="sf-preview-tabs"><button aria-pressed={!raw} onClick={() => setRaw(false)}>正文</button><button aria-pressed={raw} onClick={() => setRaw(true)}>原文</button></div>}
      <span className="sf-lock"><LockKeyhole size={12} />只读</span>
    </div>
    {contentTab === "source" && <div className="sf-source-location"><HardDrive size={14} /><span>来源目录</span><code>{skill.source_ref}</code></div>}
    <div className="sf-preview-scroll" key={`${contentTab}:${selected}`} onClick={event => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (!href) return;
      const resolved = new URL(href, `https://prototype.invalid/${selected}`).pathname.slice(1);
      if (entries.some(item => item.path === resolved)) {
        choose(resolved);
        const parts = resolved.split("/");
        setExpanded(current => [...new Set([...current, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))])]);
      }
    }}>
      <FileContents entry={entry} path={selected} raw={raw} side={contentTab === "source" ? "来源版本" : "当前安装"} />
    </div>
    <div className="sf-reader-footer"><span>{entry?.kind === "text" ? `${isMarkdown ? "Markdown" : selected.endsWith(".py") ? "Python" : "纯文本"} · UTF-8` : "文件信息"}</span><span>{entry?.size ?? "—"} · {contentTab === "source" ? "来源文件" : "当前安装文件"}</span></div>
  </section>;

  const contentNav = <nav className="sf-content-tabs" aria-label="技能详情内容模块">
    <div className="sf-content-tab-buttons">
      <button aria-pressed={contentTab === "local"} onClick={() => setContentTab("local")}><FolderOpen size={15} />本地文件</button>
      <button aria-pressed={contentTab === "diff"} onClick={() => setContentTab("diff")}><GitCompareArrows size={15} />差异<span className="sf-tab-count">{exampleDiff.length}</span></button>
      <button aria-pressed={contentTab === "source"} onClick={() => setContentTab("source")}><History size={15} />来源</button>
    </div>
    <span className="sf-content-context">{contentTab === "local" ? "中央技能库 · 当前安装" : "本地来源 · 示例快照"}</span>
  </nav>;

  const diffReader = <section className="sf-reader" aria-label="技能来源差异">
    <div className="sf-reader-toolbar">{treeToggle}<div className="sf-file-path" title={selected}><EntryIcon entry={selectedIconEntry} /><span>{selected}</span></div><span className={`sf-compare-status sf-change-${status}`}>{comparisonLabels[status]}</span><div className="sf-preview-tabs"><button aria-pressed={!diffOnly} onClick={() => setDiffOnly(false)}>完整内容</button><button aria-pressed={diffOnly} onClick={() => setDiffOnly(true)}>仅差异</button></div></div>
    {(status === "unchanged" || status === "excluded" || status === "unavailable") && <div className="sf-comparison-notice">{status === "unchanged" ? "两份文件没有变化，仍可查看完整内容。" : status === "excluded" ? "该条目保留在完整目录中，不参与技能有效内容的差异比较。" : "文件内容无法读取，暂时无法判断是否存在变化。"}</div>}
    {diffOnly ? <div className="sf-preview-scroll"><div className="sf-diff-document">{selectedChange ? <><div className="sf-comparison-labels"><span>当前安装</span><span>来源版本</span></div><SkillSourceDiffViewer entries={[selectedChange]} /></> : <div className="sf-file-message"><GitCompareArrows size={28} /><h2>{status === "unchanged" ? "没有差异" : "暂无可显示的差异"}</h2><p>切换到“完整内容”查看两份文件。</p></div>}</div></div> : <div className="sf-comparison-files" key={selected}>
      <section className="sf-comparison-side" aria-label="当前安装完整内容"><header><span>当前安装</span><small>{localFiles.get(selected)?.size ?? "无此文件"}</small></header><div className="sf-comparison-scroll"><FileContents entry={localFiles.get(selected)} path={selected} raw side="当前安装" /></div></section>
      <section className="sf-comparison-side" aria-label="来源完整内容"><header><span>来源版本</span><small>{sourceFiles.get(selected)?.size ?? "无此文件"}</small></header><div className="sf-comparison-scroll"><FileContents entry={sourceFiles.get(selected)} path={selected} raw side="来源版本" /></div></section>
    </div>}
    <div className="sf-reader-footer"><span>两边目录的并集 · 包含未变化文件与隐藏项</span><span>当前安装 → 来源版本</span></div>
  </section>;

  const sourceInfo = <dl className="sf-info-grid">
    <div><dt>安装位置</dt><dd><strong>中央技能库</strong><code title={skill.central_path}>skills/{skill.name}</code></dd></div>
    <div><dt>来源位置</dt><dd><strong>本地文件夹</strong><span title={skill.source_ref ?? undefined}>示例来源 / {skill.name}</span></dd></div>
    <div><dt>已部署到</dt><dd><div className="sf-info-agents"><span><AgentIcon agentKey="codex" className="h-4 w-4 !border-0" />Codex</span><span><AgentIcon agentKey="claude" className="h-4 w-4 !border-0" />Claude Code</span></div><span className="sf-deployment-note"><Check size={12} />2 个 Agent 已启用</span></dd></div>
    <div><dt>目录内容</dt><dd><strong>{fileCount} 个文件<span className="sf-count-separator">·</span>{directoryCount} 个目录</strong><span>包含隐藏项与缓存</span></dd></div>
  </dl>;
  const back = <button className="sf-back" onClick={() => setOpen(false)}><ArrowLeft size={15} />技能库</button>;
  const header = variant === "A" ? <header className="sf-a-header">{back}<div className="sf-title-line"><div className="sf-skill-icon"><BookOpen size={23} /></div><div><div className="sf-eyebrow">技能详情</div><h1>{skill.name}</h1></div><span className="sf-status"><Check size={13} />已安装</span></div><p className="sf-description">{skill.description}</p><div className="sf-meta-inline"><span><HardDrive size={14} />本地安装</span><span>Codex · Claude Code</span><span>{fileCount} 个文件</span><button onClick={() => setMetadataOpen(!metadataOpen)} aria-expanded={metadataOpen}>详细信息<ChevronDown size={12} /></button></div>{metadataOpen && <div className="sf-inline-details">{sourceInfo}</div>}</header> : variant === "B" ? <header className="sf-b-header"><div className="sf-b-heading">{back}<span className="sf-b-separator">/</span><div className="sf-skill-icon"><BookOpen size={19} /></div><div><h1>{skill.name}</h1><p>本地安装 · {fileCount} 个文件 · Codex、Claude Code</p></div><span className="sf-status"><Check size={13} />已安装</span><button className="sf-info-button" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(!metadataOpen)}><Info size={15} />技能信息<ChevronDown size={12} className={metadataOpen ? "sf-rotate" : ""} /></button></div>{metadataOpen && <div className="sf-b-info"><p>{skill.description}</p>{sourceInfo}</div>}{contentNav}</header> : <header className="sf-c-header">{back}<span>/</span><span>{skill.name}</span><span className="sf-c-header-end"><Layers size={14} />技能详情</span></header>;
  const info = <><div className="sf-skill-icon"><BookOpen size={25} /></div><h1>{skill.name}</h1><p className="sf-context-description">{skill.description}</p><span className="sf-status"><Check size={13} />已安装</span>{sourceInfo}</>;

  return <>{!open && <button className="app-button-primary" onClick={() => setOpen(true)}><FolderOpen size={16} />重新打开技能文件原型</button>}{createPortal(<>
    {open && <div className={`sf-prototype sf-layout-${variant.toLowerCase()}`} role="dialog" aria-modal="false" aria-label={`技能文件原型 ${variant}`}>
      {variant === "A" ? <VariantA header={header} tree={tree} reader={reader} /> : variant === "B" ? <VariantB header={header} tree={tree} reader={contentTab === "diff" ? diffReader : reader} /> : <VariantC header={header} info={info} tree={tree} reader={reader} />}
    </div>}
    <PrototypeSwitcher label={`${variant} · ${variant === "B" ? "已选基线" : names[variant]}`}><button title="切换明暗外观" aria-label="切换明暗外观" onClick={() => { setDark(!dark); document.documentElement.classList.toggle("dark", !dark); }}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button><button aria-label="查看原型状态" aria-pressed={showState} onClick={() => setShowState(!showState)}>状态</button></PrototypeSwitcher>
    {showState && <pre className="sf-state" aria-label="原型完整状态">{JSON.stringify(state, null, 2)}</pre>}
  </>, document.body)}</>;
}
