import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, FileText, Folder, GitCompareArrows, Link2, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SkillBrowserIndex, SkillFilePreview, SkillBrowserDiff, SkillBrowserEntry } from "../lib/tauri";
import { SkillMarkdown } from "./SkillMarkdown";
import "./SkillFileBrowser.css";
import { SkillFileText } from "./SkillFileText";
import { SkillSourceDiffViewer } from "./SkillSourceDiffViewer";

interface Props {
  index: SkillBrowserIndex;
  selected: string | null;
  onSelect: (path: string) => void;
  preview: SkillFilePreview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  side?: "local" | "source" | "diff";
  diff?: SkillBrowserDiff | null;
  sourcePreview?: SkillFilePreview | null;
  sourceError?: string | null;
}

export function SkillFileBrowser({ index, selected, onSelect, preview, loading, error, onRetry, side = "local", diff, sourcePreview = null, sourceError = null }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [treeVisible, setTreeVisible] = useState(true);
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const [linkError, setLinkError] = useState<{ path: string | null; side: string; session: string; message: string } | null>(null);
  const comparisons = useMemo(() => new Map(diff?.entries.map(entry => [entry.path, entry])), [diff]);
  const linkTarget = index.entries.find(entry => entry.path === selected)?.link_target;
  const changes = useMemo(() => {
    const paths = new Set(diff?.entries.filter(entry => entry.status === "added" || entry.status === "removed" || entry.status === "modified").map(entry => entry.path));
    const ancestors = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/");
      parts.slice(0, -1).forEach((_, i) => ancestors.add(parts.slice(0, i + 1).join("/")));
    }
    return { paths, ancestors };
  }, [diff]);
  const filtering = side === "diff" && changesOnly;
  const filteredEntries = filtering ? index.entries.filter(entry => changes.paths.has(entry.path) || changes.ancestors.has(entry.path)) : index.entries;
  const isFileInView = (entry: SkillBrowserEntry) => filtering ? changes.paths.has(entry.path) : entry.kind !== "directory";
  const fileCount = filtering ? filteredEntries.filter(isFileInView).length : index.file_count;
  const directoryCount = filtering ? filteredEntries.length - fileCount : index.directory_count;
  const hasUncomparable = diff?.entries.some(entry => entry.status === "uncomparable") ?? false;
  const resultsIncomplete = !index.complete || hasUncomparable;
  const search = query.trim().toLocaleLowerCase();
  const chooseFile = (path: string) => {
    const parts = path.split("/");
    setExpanded(current => [...new Set([...current, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))])]);
    setLinkError(null);
    onSelect(path);
  };
  const navigate = (href: string) => {
    if (!selected || href.startsWith("#")) return;
    const fail = (message: string) => setLinkError({ path: selected, side, session: index.session_id, message });
    if (/^(https?:|mailto:)/i.test(href)) {
      setLinkError(null);
      void openUrl(href).catch(() => fail(t("skillBrowser.externalLinkFailed")));
      return;
    }
    let target: string;
    try { target = decodeURIComponent(href.split(/[?#]/)[0]); }
    catch { fail(t("skillBrowser.invalidLink")); return; }
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\") || [...target].some(char => char < " " || char === "\x7f")) {
      fail(t("skillBrowser.invalidLink")); return;
    }
    const parts = selected.split("/").slice(0, -1);
    for (const part of target.split("/")) {
      if (part === "..") {
        if (!parts.length) { fail(t("skillBrowser.invalidLink")); return; }
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    const path = parts.join("/");
    const entry = index.entries.find(entry => entry.path === path);
    if (!entry || entry.kind === "directory") { fail(t("skillBrowser.linkMissing", { path })); return; }
    setQuery("");
    chooseFile(path);
  };
  const visibleEntries = filteredEntries.filter(entry => {
    if (search) return isFileInView(entry) && entry.path.toLocaleLowerCase().includes(search);
    const parts = entry.path.split("/");
    return parts.slice(0, -1).every((_, i) => expanded.includes(parts.slice(0, i + 1).join("/")));
  });
  return <div className="skill-file-browser">
    {treeVisible && <nav className="skill-file-tree" aria-label={t(filtering ? "skillBrowser.changedTree" : `skillBrowser.${side}Tree`)}>
      <div className="skill-file-tree-title"><Folder size={16} /><strong>{t(filtering ? "skillBrowser.changedTreeTitle" : "skillBrowser.allFiles")}</strong></div>
      <div className="skill-file-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label={t("skillBrowser.search")} placeholder={t("skillBrowser.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button aria-label={t("skillBrowser.clearSearch")} onClick={() => setQuery("")}><X size={14} /></button>}
      </div>
      {side === "diff" && <div className="skill-file-filter">
        <button aria-label={t("skillBrowser.onlyChangesLabel")} aria-pressed={changesOnly} onClick={() => {
          setChangesOnly(!changesOnly);
          if (!changesOnly) setExpanded(current => [...new Set([...current, ...changes.ancestors])]);
        }}><GitCompareArrows size={13} aria-hidden="true" />{t("skillBrowser.onlyChanges")}<span>{diff?.changed_file_count ?? 0}</span></button>
        {changesOnly && <small>{t("skillBrowser.filterActive")}</small>}
      </div>}
      {search && <p role="status" className="skill-file-search-count">{t("skillBrowser.matches", { count: visibleEntries.length })}</p>}
      <div className="skill-file-tree-list">
        {filtering && !filteredEntries.length ? <div className="skill-file-empty" role="status"><p>{t(resultsIncomplete ? "skillBrowser.noConfirmedChanges" : "skillBrowser.noChanges")}</p><button onClick={() => setChangesOnly(false)}>{t("skillBrowser.restoreAll")}</button></div>
          : search && !visibleEntries.length && <p className="skill-file-empty">{t(resultsIncomplete ? "skillBrowser.noKnownMatches" : "skillBrowser.noMatches")}</p>}
        {visibleEntries.map(entry => {
          const depth = search ? 0 : entry.path.split("/").length - 1;
          const comparison = comparisons.get(entry.path);
          const isDirectory = !isFileInView(entry);
          const directoryMessage = entry.error || (comparison?.reason_code === "unknown_presence" ? t("skillBrowser.diffReason.unknown_presence") : null);
          const isContainer = isDirectory || comparison?.local?.kind === "directory" || comparison?.source?.kind === "directory";
          const isExpanded = expanded.includes(entry.path);
          const Icon = isDirectory ? Folder : entry.kind === "symlink" ? Link2 : /\.md$/i.test(entry.path) ? FileText : File;
          return <div key={entry.path}>
            <button className="skill-file-row" title={entry.path} aria-label={entry.path} aria-current={selected === entry.path ? "true" : undefined}
              aria-expanded={isContainer ? isExpanded : undefined} style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => { if (isContainer) setExpanded(current => isExpanded ? current.filter(path => path !== entry.path) : [...current, entry.path]); if (!isDirectory) chooseFile(entry.path); }}>
              {isContainer ? isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="skill-file-indent" />}
              <Icon size={16} /><span className={search ? "skill-file-result-path" : "skill-file-name"}>{search ? entry.path : entry.path.split("/").pop()}</span>
              {entry.path === index.entry_path && <small>{t("skillBrowser.entry")}</small>}
              {!isDirectory && entry.kind === "symlink" && <small>{t("skillBrowser.link")}</small>}
              {entry.error && <small title={entry.error}>!</small>}
              {!isDirectory && comparison?.status && <small>{t(`skillBrowser.diffStatus.${comparison.status}`)}</small>}
            </button>
            {isDirectory && isExpanded && (directoryMessage || !index.entries.some(child => child.path.startsWith(`${entry.path}/`))) && <p className="skill-file-empty" style={{ paddingLeft: 40 + depth * 14 }}>{directoryMessage || t("skillBrowser.emptyDirectory")}</p>}
          </div>;
        })}
        {!filtering && index.complete && !index.entries.length && <p className="skill-file-empty">{t("skillBrowser.emptyDirectory")}</p>}
      </div>
      <div className="skill-file-footer">
        <span>{t(index.complete ? "skillBrowser.counts" : "skillBrowser.partialCounts", { files: fileCount, directories: directoryCount })}</span>
        <span>{t(filtering ? "skillBrowser.filteredHint" : "skillBrowser.includesHidden")}</span>
        {diff && <span>{t("skillBrowser.changedFiles", { count: diff.changed_file_count })}</span>}
        {!index.complete && <><span role="alert">{t("skillBrowser.incomplete")}</span>{index.issues.map(issue => <span key={issue}>{issue}</span>)}</>}
        {hasUncomparable && <span role="alert">{t("skillBrowser.comparisonIncomplete")}</span>}
        {resultsIncomplete && <button onClick={onRetry}>{t("skillBrowser.reload")}</button>}
      </div>
    </nav>}
    <section className="skill-file-reader" aria-label={t(`skillBrowser.${side}Preview`)}>
      <div className="skill-file-toolbar">
        <button aria-label={t(treeVisible ? "skillBrowser.hideTree" : "skillBrowser.showTree")} onClick={() => setTreeVisible(!treeVisible)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
        <span className="skill-file-path" title={selected ?? undefined}>{selected ?? t("skillBrowser.chooseFile")}</span>
        {side !== "diff" && selected && /\.md$/i.test(selected) && preview?.kind === "text" && <div className="skill-file-modes" aria-label={t("skillBrowser.previewMode")}>
          <button aria-pressed={!raw} onClick={() => setRaw(false)}>{t("skillBrowser.body")}</button>
          <button aria-pressed={raw} onClick={() => setRaw(true)}>{t("skillBrowser.raw")}</button>
        </div>}
        {side === "diff" && <div className="skill-file-modes" aria-label={t("skillBrowser.previewMode")}>
          <button aria-pressed={!onlyDiff} onClick={() => setOnlyDiff(false)}>{t("skillBrowser.fullContent")}</button>
          <button aria-pressed={onlyDiff} onClick={() => setOnlyDiff(true)}>{t("skillBrowser.onlyDiff")}</button>
        </div>}
        <small>{t("skillBrowser.readOnly")}</small>
      </div>
      {linkError?.path === selected && linkError?.side === side && linkError?.session === index.session_id && <p role="alert" className="skill-file-link-error">{linkError.message}</p>}
      <div className="skill-file-content" key={selected}>
        {side === "diff" ? <SkillSourceDiffViewer onlyDiff={onlyDiff} entry={comparisons.get(selected ?? "") ?? null} original={preview} updated={sourcePreview} originalError={error} updatedError={sourceError} onRetry={onRetry} /> : loading ? <p role="status" className="skill-file-message">{t("common.loading")}</p>
          : error ? <div role="alert" className="skill-file-message"><p>{error}</p><button onClick={onRetry}>{t("skillBrowser.reload")}</button></div>
          : !selected ? <p className="skill-file-message">{t("skillBrowser.chooseFile")}</p>
          : preview?.kind === "text" ? /\.md$/i.test(selected) && !raw
            ? <div className="skill-file-markdown"><SkillMarkdown content={preview.text ?? ""} onNavigate={navigate} /></div>
            : <SkillFileText text={preview.text ?? ""} />
          : preview ? <div className="skill-file-message"><File size={26} /><h3>{selected}</h3><p>{preview.message ?? t(`skillBrowser.previewKind.${preview.kind}`)}</p>{linkTarget && <code>{linkTarget}</code>}<small>{preview.size} B</small></div>
          : null}
      </div>
    </section>
  </div>;
}
