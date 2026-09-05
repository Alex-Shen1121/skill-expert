// 一次性原型：在现有 /my-skills 路由通过 ?variant=A|B|C 比较三种左树右预览布局。
// 待用户验证：完整介绍、紧凑工具栏、独立信息栏，哪一种更方便浏览技能文件？
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ChevronsDownUp, Code2, File, FileText, Folder, FolderOpen, Image, Link2, PanelLeftClose, PanelLeftOpen, Search, LockKeyhole, Sun, Moon, ArrowLeft, Info, Layers, HardDrive, Check, BookOpen } from "lucide-react";
import { SkillMarkdown } from "./SkillMarkdown";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { exampleEntries, type ExampleEntry } from "./SkillFiles.prototype.data";
import type { ManagedSkill } from "../lib/tauri";
import "./SkillFiles.prototype.css";

const names: Record<string, string> = { A: "完整介绍", B: "紧凑工作台", C: "独立信息栏" };
const fileCount = exampleEntries.filter(entry => entry.kind !== "directory").length;
const directoryCount = exampleEntries.length - fileCount;

function EntryIcon({ entry }: { entry: ExampleEntry }) {
  const Icon = entry.kind === "directory" ? Folder : entry.kind === "symlink" ? Link2 : entry.path.endsWith(".md") ? FileText : entry.path.endsWith(".png") ? Image : /\.(py|json)$/.test(entry.path) ? Code2 : File;
  return <Icon size={15} className={entry.path === "SKILL.md" ? "sf-accent" : ""} />;
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
  const [params] = useSearchParams();
  const requested = params.get("variant") ?? "B";
  const variant = names[requested] ? requested : "B";
  const [selected, setSelected] = useState("SKILL.md");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(true);
  const [showState, setShowState] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const entry = exampleEntries.find(item => item.path === selected)!;
  const isMarkdown = entry.path.endsWith(".md");
  const matches = exampleEntries.filter(item => item.path.toLowerCase().includes(query.toLowerCase()));
  const state = { "方案": variant, "选中文件": selected, "展开目录": expanded, "目录可见": treeVisible, "过滤词": query, "预览模式": raw ? "原文" : "正文", "条目类型": entry.kind, "弹层打开": open };
  useEffect(() => { console.info("技能文件原型状态", { variant, selected, expanded, treeVisible, query, raw, open }); }, [variant, selected, expanded, treeVisible, query, raw, open]);

  const choose = (path: string) => { setSelected(path); setRaw(false); };
  const toggleDirectory = (path: string) => {
    if (query) {
      const parts = path.split("/");
      setExpanded(current => [...new Set([...current, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))])]);
      setQuery("");
    } else setExpanded(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path]);
  };
  const childrenOf = (parent: string) => exampleEntries.filter(item => item.path.split("/").slice(0, -1).join("/") === parent);
  const renderEntries = (items: ExampleEntry[], depth = 0): ReactNode => <ul>
    {items.map(item => <li key={item.path}>
      <button className={`sf-file-row ${selected === item.path ? "sf-file-selected" : ""}`} style={{ paddingLeft: 12 + depth * 15 }}
        title={item.path} aria-label={item.path} aria-current={selected === item.path ? "true" : undefined}
        aria-expanded={item.kind === "directory" ? expanded.includes(item.path) || !!query : undefined}
        onClick={() => item.kind === "directory" ? toggleDirectory(item.path) : choose(item.path)}>
        {item.kind === "directory" ? (expanded.includes(item.path) || query ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="sf-tree-spacer" />}
        <EntryIcon entry={item} /><span>{query ? item.path : item.path.split("/").pop()}</span>
        {item.path === "SKILL.md" && <small>入口</small>}
        {item.kind === "symlink" && <small>链接</small>}
      </button>
      {!query && item.kind === "directory" && expanded.includes(item.path) && (childrenOf(item.path).length ? renderEntries(childrenOf(item.path), depth + 1) : <div className="sf-empty-folder" style={{ paddingLeft: 42 + depth * 15 }}>空目录</div>)}
    </li>)}
  </ul>;

  const tree = treeVisible && <nav className="sf-tree" aria-label="技能完整文件目录">
    <div className="sf-tree-heading"><span><FolderOpen size={15} />全部文件</span><button title="折叠所有目录" aria-label="折叠所有目录" onClick={() => setExpanded([])}><ChevronsDownUp size={15} /></button></div>
    <label className="sf-search"><Search size={14} /><input aria-label="查找文件" placeholder="查找文件…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清除文件查找" onClick={() => setQuery("")}>×</button>}</label>
    <div className="sf-file-list">{renderEntries(query ? matches : childrenOf(""))}{query && matches.length === 0 && <p className="sf-empty-folder">没有匹配的文件</p>}</div>
    <div className="sf-tree-footer">{query ? `${matches.length} 个匹配项` : `${fileCount} 个文件 · ${directoryCount} 个目录`}<span>包含隐藏项与缓存</span></div>
  </nav>;

  const reader = <section className="sf-reader" aria-label="文件只读预览">
    <div className="sf-reader-toolbar">
      <button className="sf-icon-button" aria-label={treeVisible ? "收起目录树" : "展开目录树"} title={treeVisible ? "收起目录树" : "展开目录树"} onClick={() => setTreeVisible(!treeVisible)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
      <div className="sf-file-path" title={entry.path}><EntryIcon entry={entry} /><span>{entry.path}</span></div>
      {isMarkdown && <div className="sf-preview-tabs"><button aria-pressed={!raw} onClick={() => setRaw(false)}>正文</button><button aria-pressed={raw} onClick={() => setRaw(true)}>原文</button></div>}
      <span className="sf-lock"><LockKeyhole size={12} />只读</span>
    </div>
    <div className="sf-preview-scroll" key={selected} onClick={event => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (!href) return;
      const resolved = new URL(href, `https://prototype.invalid/${entry.path}`).pathname.slice(1);
      if (exampleEntries.some(item => item.path === resolved)) {
        choose(resolved);
        const parts = resolved.split("/");
        setExpanded(current => [...new Set([...current, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))])]);
      }
    }}>
      {entry.kind === "text" ? (isMarkdown && !raw ? <div className="sf-document"><SkillMarkdown content={entry.body ?? ""} /></div> : <div className="sf-code"><pre aria-label="文件原文">{entry.body?.split("\n").map((line, index) => <div className="sf-code-line" key={index}><span aria-hidden="true">{index + 1}</span><code>{line || " "}</code></div>)}</pre></div>) : <div className="sf-file-message"><div className="sf-file-message-icon"><EntryIcon entry={entry} /></div><h2>{entry.path.split("/").pop()}</h2><p>{entry.note}</p><span>{entry.size} · {entry.kind === "symlink" ? "符号链接" : entry.kind === "unreadable" ? "无法读取" : entry.kind === "large" ? "超大文件" : "二进制文件"}</span></div>}
    </div>
    <div className="sf-reader-footer"><span>{entry.kind === "text" ? `${isMarkdown ? "Markdown" : entry.path.endsWith(".py") ? "Python" : "纯文本"} · UTF-8` : "文件信息"}</span><span>{entry.size} · 当前安装文件</span></div>
  </section>;

  const sourceInfo = <><div className="sf-detail-label">安装位置</div><p className="sf-location">中央技能库<br /><span>skills/document-workflow</span></p><div className="sf-detail-label">来源</div><p>本地安装</p><div className="sf-detail-label">已部署到</div><div className="sf-agent-tags"><span><Check size={12} />Codex</span><span><Check size={12} />Claude Code</span></div><div className="sf-detail-label">目录范围</div><p>{fileCount} 个文件<br />{directoryCount} 个目录<br /><span className="sf-muted">包含隐藏项与缓存</span></p></>;
  const back = <button className="sf-back" onClick={() => setOpen(false)}><ArrowLeft size={15} />技能库</button>;
  const header = variant === "A" ? <header className="sf-a-header">{back}<div className="sf-title-line"><div className="sf-skill-icon"><BookOpen size={23} /></div><div><div className="sf-eyebrow">技能详情</div><h1>{skill.name}</h1></div><span className="sf-status"><Check size={13} />已安装</span></div><p className="sf-description">{skill.description}</p><div className="sf-meta-inline"><span><HardDrive size={14} />本地安装</span><span>Codex · Claude Code</span><span>{fileCount} 个文件</span><button onClick={() => setMetadataOpen(!metadataOpen)} aria-expanded={metadataOpen}>详细信息<ChevronDown size={12} /></button></div>{metadataOpen && <div className="sf-inline-details">{sourceInfo}</div>}</header> : variant === "B" ? <header className="sf-b-header"><div className="sf-b-heading">{back}<span className="sf-b-separator">/</span><div className="sf-skill-icon"><BookOpen size={19} /></div><div><h1>{skill.name}</h1><p>本地安装 · {fileCount} 个文件 · Codex、Claude Code</p></div><span className="sf-status"><Check size={13} />已安装</span><button className="sf-info-button" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(!metadataOpen)}><Info size={15} />技能信息</button></div>{metadataOpen && <div className="sf-b-info"><p>{skill.description}</p>{sourceInfo}</div>}</header> : <header className="sf-c-header">{back}<span>/</span><span>{skill.name}</span><span className="sf-c-header-end"><Layers size={14} />技能详情</span></header>;
  const info = <><div className="sf-skill-icon"><BookOpen size={25} /></div><h1>{skill.name}</h1><p className="sf-context-description">{skill.description}</p><span className="sf-status"><Check size={13} />已安装</span>{sourceInfo}</>;

  return <>{!open && <button className="app-button-primary" onClick={() => setOpen(true)}><FolderOpen size={16} />重新打开技能文件原型</button>}{createPortal(<>
    {open && <div className={`sf-prototype sf-layout-${variant.toLowerCase()}`} role="dialog" aria-modal="false" aria-label={`技能文件原型 ${variant}`}>
      {variant === "A" ? <VariantA header={header} tree={tree} reader={reader} /> : variant === "B" ? <VariantB header={header} tree={tree} reader={reader} /> : <VariantC header={header} info={info} tree={tree} reader={reader} />}
    </div>}
    <PrototypeSwitcher label={`${variant} · ${names[variant]}`}><button title="切换明暗外观" aria-label="切换明暗外观" onClick={() => { setDark(!dark); document.documentElement.classList.toggle("dark", !dark); }}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button><button aria-label="查看原型状态" aria-pressed={showState} onClick={() => setShowState(!showState)}>状态</button></PrototypeSwitcher>
    {showState && <pre className="sf-state" aria-label="原型完整状态">{JSON.stringify(state, null, 2)}</pre>}
  </>, document.body)}</>;
}
