import { useState } from "react";
import { ChevronDown, ChevronRight, File, FileText, Folder, Link2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillBrowserIndex, SkillFilePreview } from "../lib/tauri";
import { SkillMarkdown } from "./SkillMarkdown";
import "./SkillFileBrowser.css";

interface Props {
  index: SkillBrowserIndex;
  selected: string | null;
  onSelect: (path: string) => void;
  preview: SkillFilePreview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function SkillFileBrowser({ index, selected, onSelect, preview, loading, error, onRetry }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [treeVisible, setTreeVisible] = useState(true);
  const visibleEntries = index.entries.filter(entry => {
    const parts = entry.path.split("/");
    return parts.slice(0, -1).every((_, i) => expanded.includes(parts.slice(0, i + 1).join("/")));
  });
  return <div className="skill-file-browser">
    {treeVisible && <nav className="skill-file-tree" aria-label={t("skillBrowser.localTree")}>
      <div className="skill-file-tree-title"><Folder size={16} /><strong>{t("skillBrowser.allFiles")}</strong></div>
      <div className="skill-file-tree-list">
        {visibleEntries.map(entry => {
          const depth = entry.path.split("/").length - 1;
          const isDirectory = entry.kind === "directory";
          const isExpanded = expanded.includes(entry.path);
          const Icon = isDirectory ? Folder : entry.kind === "symlink" ? Link2 : /\.md$/i.test(entry.path) ? FileText : File;
          return <div key={entry.path}>
            <button className="skill-file-row" title={entry.path} aria-label={entry.path} aria-current={selected === entry.path ? "true" : undefined}
              aria-expanded={isDirectory ? isExpanded : undefined} style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => isDirectory ? setExpanded(current => isExpanded ? current.filter(path => path !== entry.path) : [...current, entry.path]) : onSelect(entry.path)}>
              {isDirectory ? isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="skill-file-indent" />}
              <Icon size={16} /><span className="skill-file-name">{entry.path.split("/").pop()}</span>
              {entry.path === index.entry_path && <small>{t("skillBrowser.entry")}</small>}
              {entry.kind === "symlink" && <small>{t("skillBrowser.link")}</small>}
              {entry.error && <small title={entry.error}>!</small>}
            </button>
            {isDirectory && isExpanded && (entry.error || !index.entries.some(child => child.path.startsWith(`${entry.path}/`))) && <p className="skill-file-empty" style={{ paddingLeft: 40 + depth * 14 }}>{entry.error || t("skillBrowser.emptyDirectory")}</p>}
          </div>;
        })}
        {index.complete && !index.entries.length && <p className="skill-file-empty">{t("skillBrowser.emptyDirectory")}</p>}
      </div>
      <div className="skill-file-footer">
        <span>{t(index.complete ? "skillBrowser.counts" : "skillBrowser.partialCounts", { files: index.file_count, directories: index.directory_count })}</span>
        <span>{t("skillBrowser.includesHidden")}</span>
        {!index.complete && <><span role="alert">{t("skillBrowser.incomplete")}</span>{index.issues.map(issue => <span key={issue}>{issue}</span>)}<button onClick={onRetry}>{t("skillBrowser.reload")}</button></>}
      </div>
    </nav>}
    <section className="skill-file-reader" aria-label={t("skillBrowser.localPreview")}>
      <div className="skill-file-toolbar">
        <button aria-label={t(treeVisible ? "skillBrowser.hideTree" : "skillBrowser.showTree")} onClick={() => setTreeVisible(!treeVisible)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
        <span className="skill-file-path" title={selected ?? undefined}>{selected ?? t("skillBrowser.chooseFile")}</span>
        <small>{t("skillBrowser.readOnly")}</small>
      </div>
      <div className="skill-file-content" key={selected}>
        {loading ? <p role="status" className="skill-file-message">{t("common.loading")}</p>
          : error ? <div role="alert" className="skill-file-message"><p>{error}</p><button onClick={onRetry}>{t("skillBrowser.reload")}</button></div>
          : !selected ? <p className="skill-file-message">{t("skillBrowser.chooseFile")}</p>
          : preview?.kind === "text" ? /\.md$/i.test(selected)
            ? <div className="skill-file-markdown"><SkillMarkdown content={preview.text ?? ""} /></div>
            : <pre aria-label={t("skillBrowser.rawContent")} className="skill-file-code">{(preview.text ?? "").split("\n").map((line, number) => <div key={number}><span aria-hidden="true">{number + 1}</span><code>{line || " "}</code></div>)}</pre>
          : preview ? <div className="skill-file-message"><File size={26} /><h3>{selected}</h3><p>{preview.message ?? t(`skillBrowser.previewKind.${preview.kind}`)}</p><small>{preview.size} B</small></div>
          : null}
      </div>
    </section>
  </div>;
}
