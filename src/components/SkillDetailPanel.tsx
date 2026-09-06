import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils";
import {
  openSkillBrowser, readSkillBrowserFile, closeSkillBrowser,
  prepareSkillBrowserSource, getSkillBrowserDiff,
  type ManagedSkill, type Project, type SkillBrowserSource, type SkillBrowserDiff,
  type SkillToolToggle, type ToolInfo, type SkillBrowserIndex, type SkillFilePreview,
} from "../lib/tauri";
import { getErrorMessage, getErrorKind } from "../lib/error";
import { DetailSheet } from "./DetailSheet";
import { SkillFileBrowser } from "./SkillFileBrowser";
import { AgentToggleSection, type AgentToggleItem } from "./AgentToggleSection";
import { SkillProjectsSection } from "./SkillProjectsSection";
import { SyncDots } from "./SyncDots";

interface Props {
  skill: ManagedSkill | null;
  onClose: () => void;
  tools?: ToolInfo[];
  toolToggles?: SkillToolToggle[] | null;
  togglingTool?: string | null;
  onToggleTool?: (tool: string, enabled: boolean) => void;
  projects?: Project[];
  onProjectsChanged?: () => void;
}

export function SkillDetailPanel(props: Props) {
  const { skill } = props;
  if (!skill) return null;
  const panelKey = [skill.id, skill.updated_at, skill.source_type, skill.source_ref, skill.source_ref_resolved, skill.source_revision, skill.remote_revision].join(":");
  return <SkillDetailPanelContent key={panelKey} {...props} skill={skill} />;
}

function SkillDetailPanelContent({ skill, onClose, tools, toolToggles, togglingTool, onToggleTool, projects, onProjectsChanged }: Props & { skill: ManagedSkill }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState<SkillBrowserIndex | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Partial<Record<"local" | "source", { key: string; value: SkillFilePreview }>>>({});
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Partial<Record<"local" | "source", { key: string; message: string }>>>({});
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [source, setSource] = useState<SkillBrowserSource | null>(null);
  const [sourceWanted, setSourceWanted] = useState(false);
  const [sourceDiff, setSourceDiff] = useState<SkillBrowserDiff | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<"local" | "diff" | "source">("local");
  const skillId = skill.id;
  const supportsSource = ["git", "skillssh"].includes(skill.source_type) || (["local", "import"].includes(skill.source_type) && !!skill.source_ref);
  const activeIndex = contentTab === "diff" ? sourceDiff?.index ?? null : contentTab === "source" ? source?.index ?? null : index;
  const readKey = `${index?.session_id}:${selected}`;
  const previewFor = (side: "local" | "source") => previews[side]?.key === readKey ? previews[side]!.value : null;
  const errorFor = (side: "local" | "source") => previewErrors[side]?.key === readKey ? previewErrors[side]!.message : null;
  const side = contentTab === "source" ? "source" : "local";
  const currentPreview = previewFor(side);
  const currentPreviewError = errorFor(side);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    openSkillBrowser(skillId).then(next => {
      sessionId = next.session_id;
      if (cancelled) { void closeSkillBrowser(skillId, next.session_id).catch(() => {}); return; }
      setIndex(next);
      setSelected(current => current ?? next.entry_path);
    }).catch(error => {
      if (!cancelled) setBrowseError(getErrorMessage(error, t("skillBrowser.loadFailed")));
    });
    return () => {
      cancelled = true;
      if (sessionId) void closeSkillBrowser(skillId, sessionId).catch(() => {});
    };
  }, [skillId, reload, t]);

  useEffect(() => {
    if (!index || !sourceWanted || !supportsSource) return;
    let cancelled = false;
    prepareSkillBrowserSource(skillId, index.session_id).then(next => {
      if (!cancelled) setSource(next);
    }).catch(error => {
      if (!cancelled) setSourceError(getErrorMessage(error, t("mySkills.sourceDiffUnavailable")));
    });
    return () => { cancelled = true; };
  }, [skillId, index, sourceWanted, supportsSource, t]);

  useEffect(() => {
    if (!index || !selected || (contentTab !== "local" && !source) || (contentTab === "diff" && !sourceDiff)) return;
    let cancelled = false;
    const sides: ("local" | "source")[] = contentTab === "diff" ? ["local", "source"] : [contentTab];
    for (const readingSide of sides) {
      const readingIndex = readingSide === "local" ? index : source!.index;
      readSkillBrowserFile(skillId, index.session_id, selected, readingSide).then(next => {
        if (!cancelled) setPreviews(current => ({ ...current, [readingSide]: { key: readKey, value: next } }));
      }).catch(error => {
        if (cancelled) return;
        if (getErrorKind(error) === "not_found" && !readingIndex.entries.some(entry => entry.path === selected)) {
          setPreviews(current => ({ ...current, [readingSide]: { key: readKey, value: { path: selected, kind: "missing", size: 0, text: null, message: t("skillBrowser.missingFile") } } }));
          return;
        }
        const message = getErrorKind(error) === "unknown_presence" ? t("skillBrowser.diffReason.unknown_presence") : getErrorMessage(error, t("skillBrowser.readFailed"));
        setPreviewErrors(current => ({ ...current, [readingSide]: { key: readKey, message } }));
        if (getErrorKind(error) === "stale_snapshot") { setSourceDiff(null); setDiffError(message); }
      });
    }
    return () => { cancelled = true; };
  }, [skillId, index, source, sourceDiff, selected, readKey, contentTab, t]);

  useEffect(() => {
    if (contentTab !== "diff" || !index || !source || sourceDiff || diffError) return;
    let cancelled = false;
    getSkillBrowserDiff(skillId, index.session_id).then(next => { if (!cancelled) setSourceDiff(next); })
      .catch(error => { if (!cancelled) setDiffError(getErrorMessage(error, t("mySkills.sourceDiffUnavailable"))); });
    return () => { cancelled = true; };
  }, [contentTab, index, source, sourceDiff, diffError, skillId, t]);

  const chooseFile = (path: string) => { if (path === selected) return; setSelected(path); setPreviews({}); setPreviewErrors({}); };
  const retry = () => { setIndex(null); setSource(null); setSourceDiff(null); setSourceError(null); setDiffError(null); setPreviews({}); setBrowseError(null); setPreviewErrors({}); setReload(current => current + 1); };
  const toggleItems: AgentToggleItem[] = (toolToggles ?? []).map(toggle => ({
    key: toggle.tool, displayName: toggle.display_name, enabled: toggle.enabled,
    isAvailable: toggle.installed && toggle.globally_enabled, disabled: !toggle.installed || !toggle.globally_enabled,
    badgeLabel: !toggle.installed ? t("mySkills.agentToggleNotInstalled") : !toggle.globally_enabled ? t("mySkills.agentToggleDisabledGlobally") : null,
  }));
  const metadataItems = [
    { label: t("mySkills.sourceType"), value: t(`mySkills.sourceFilter.${skill.source_type}`, { defaultValue: skill.source_type }) },
    { label: t("mySkills.sourceRef"), value: skill.source_ref },
    { label: t("mySkills.sourceResolved"), value: skill.source_ref_resolved },
    { label: t("mySkills.sourceBranch"), value: skill.source_branch },
    { label: t("mySkills.sourceSubpath"), value: skill.source_subpath },
    { label: t("mySkills.sourceRevision"), value: skill.source_revision },
    { label: t("skillBrowser.snapshotLocation"), value: source?.location },
    { label: t("skillBrowser.snapshotRevision"), value: source ? source.revision === "workspace" ? t("skillBrowser.workspaceSnapshot") : source.revision : null },
  ].filter(item => item.value);
  const meta = infoExpanded ? <div id="skill-detail-info" className="max-h-[40vh] overflow-y-auto text-secondary">
    <div className="skill-info-groups">
      <section><h3>{t("skillBrowser.installLocation")}</h3><p className="font-medium">{t("skillBrowser.centralLibrary")}</p><p className="mt-2 font-mono">{skill.central_path}</p></section>
      <section><h3>{t("skillBrowser.sourceLocation")}</h3><dl>{metadataItems.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>
      <section><h3>{t("skillBrowser.deployments")}</h3>{tools && skill.targets.length > 0 && <SyncDots skill={skill} tools={tools.filter(tool => skill.targets.some(target => target.tool === tool.key))} size="sm" includeOrphan />}
        {skill.targets.length ? skill.targets.map(target => <p key={target.id} className="mt-2">{tools?.find(tool => tool.key === target.tool)?.display_name ?? target.tool} · {target.status}<span className="mt-1 block font-mono text-[11px] text-muted">{target.target_path}</span></p>) : <p>{t("skillBrowser.noDeployments")}</p>}
      </section>
      <section><h3>{t("skillBrowser.directoryContents")}</h3><p>{activeIndex ? t(activeIndex.complete ? "skillBrowser.counts" : "skillBrowser.partialCounts", { files: activeIndex.file_count, directories: activeIndex.directory_count }) : t("common.loading")}</p><p className="mt-2 text-muted">{t("skillBrowser.includesHidden")}</p>{skill.tags.length > 0 && <p className="mt-2">{skill.tags.join(" · ")}</p>}</section>
    </div>
    {toolToggles && onToggleTool && <AgentToggleSection items={toggleItems} togglingKey={togglingTool} onToggle={onToggleTool} className="mt-3" />}
    {projects && projects.length > 0 && <SkillProjectsSection skill={skill} projects={projects} onChanged={onProjectsChanged} />}
  </div> : undefined;

  return <DetailSheet open title={<span className="flex min-w-0 items-center gap-3"><BookOpen className="shrink-0 text-accent" size={25} /><span className="truncate" title={skill.name}>{skill.name}</span><button type="button" aria-expanded={infoExpanded} aria-controls="skill-detail-info" onClick={() => setInfoExpanded(value => !value)} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12px] font-normal text-muted focus-visible:outline-accent"><Info size={14} />{t("skillBrowser.skillInfo")}<ChevronDown size={12} /></button></span>}
    description={skill.description ? <p className="line-clamp-1 text-[12px] text-muted">{skill.description}</p> : undefined} meta={meta} onClose={onClose} workbench>
    <nav className="flex shrink-0 items-center gap-1 px-6 pb-2" aria-label={t("skillBrowser.modules")}>
      {(["local", "diff", "source"] as const).map(tab => <button key={tab} type="button" aria-pressed={contentTab === tab} onClick={() => { setContentTab(tab); if (tab !== "local") setSourceWanted(true); }}
        className={cn("rounded-md px-3 py-2 text-[12px] font-medium focus-visible:outline-accent", contentTab === tab ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-hover")}>
        {tab === "local" ? t("skillBrowser.localFiles") : t(`mySkills.docTabs.${tab}`)}
      </button>)}
    </nav>
    {source && contentTab !== "local" && <p className="shrink-0 break-all border-t border-border-subtle px-6 py-2 text-[11px] text-muted" title={source.revision}>{source.location} · {source.revision === "workspace" ? t("skillBrowser.workspaceSnapshot") : source.revision.slice(0, 12)}</p>}
    <div className={(contentTab === "local" || (contentTab === "source" && source) || (contentTab === "diff" && sourceDiff && !diffError)) ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {index ? <SkillFileBrowser side={contentTab} diff={contentTab === "diff" ? sourceDiff : null} sourcePreview={previewFor("source")} sourceError={errorFor("source")} index={activeIndex ?? index} selected={selected} onSelect={chooseFile} preview={currentPreview} loading={!!selected && !currentPreview && !currentPreviewError} error={currentPreviewError} onRetry={retry} />
        : <div className="skill-file-message" role={browseError ? "alert" : "status"}>{browseError ?? t("common.loading")}{browseError && <button onClick={retry}>{t("skillBrowser.reload")}</button>}</div>}
    </div>
    {contentTab !== "local" && (!source || (contentTab === "diff" && (!sourceDiff || diffError))) && <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle p-6">
      {!supportsSource ? <p className="skill-file-message">{t("skillBrowser.noSource")}</p>
        : sourceError || diffError || browseError ? <div role="alert" className="skill-file-message"><p>{sourceError ?? diffError ?? browseError}</p><button onClick={retry}>{t("skillBrowser.retrySource")}</button></div>
        : <p role="status" className="skill-file-message">{t("common.loading")}</p>}
    </div>}
  </DetailSheet>;
}
