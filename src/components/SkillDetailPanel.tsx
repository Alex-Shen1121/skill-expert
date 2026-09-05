import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils";
import {
  openSkillBrowser, readSkillBrowserFile, closeSkillBrowser,
  getSourceSkillDocument, getSkillSourceDiff,
  type ManagedSkill, type Project, type SourceSkillDocument, type SkillSourceDiff,
  type SkillToolToggle, type ToolInfo, type SkillBrowserIndex, type SkillFilePreview,
} from "../lib/tauri";
import { getErrorMessage } from "../lib/error";
import { SkillSourceDiffViewer } from "./SkillSourceDiffViewer";
import { DetailSheet } from "./DetailSheet";
import { SkillMarkdown } from "./SkillMarkdown";
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
  const [preview, setPreview] = useState<SkillFilePreview | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [sourceDoc, setSourceDoc] = useState<SourceSkillDocument | null>(null);
  const [sourceDiff, setSourceDiff] = useState<SkillSourceDiff | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<"local" | "diff" | "source">("local");
  const sourceRequested = useRef(false);
  const diffRequested = useRef(false);
  const mounted = useRef(true);
  const skillId = skill.id;
  const supportsSource = ["git", "skillssh"].includes(skill.source_type) || (["local", "import"].includes(skill.source_type) && !!skill.source_ref);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    openSkillBrowser(skillId).then(next => {
      sessionId = next.session_id;
      if (cancelled) { void closeSkillBrowser(skillId, next.session_id).catch(() => {}); return; }
      setIndex(next);
      setSelected(current => current && next.entries.some(entry => entry.path === current) ? current : next.entry_path);
    }).catch(error => {
      if (!cancelled) setBrowseError(getErrorMessage(error, t("skillBrowser.loadFailed")));
    });
    return () => {
      cancelled = true;
      if (sessionId) void closeSkillBrowser(skillId, sessionId).catch(() => {});
    };
  }, [skillId, reload, t]);

  useEffect(() => {
    if (!index || !selected) return;
    let cancelled = false;
    readSkillBrowserFile(skillId, index.session_id, selected).then(next => {
      if (!cancelled) setPreview(next);
    }).catch(error => {
      if (!cancelled) setPreviewError(getErrorMessage(error, t("skillBrowser.readFailed")));
    });
    return () => { cancelled = true; };
  }, [skillId, index, selected, t]);

  // 来源和旧差异在首次访问时才准备；本地目录始终可以离线浏览。
  useEffect(() => {
    if (!supportsSource) return;
    if (contentTab === "source" && !sourceRequested.current) {
      sourceRequested.current = true;
      getSourceSkillDocument(skillId).then(next => { if (mounted.current) setSourceDoc(next); })
        .catch(error => { if (mounted.current) setSourceError(getErrorMessage(error, t("mySkills.sourceDiffUnavailable"))); });
    }
    if (contentTab === "diff" && !diffRequested.current) {
      diffRequested.current = true;
      getSkillSourceDiff(skillId).then(next => { if (mounted.current) setSourceDiff(next); })
        .catch(error => { if (mounted.current) setDiffError(getErrorMessage(error, t("mySkills.sourceDiffUnavailable"))); });
    }
  }, [contentTab, supportsSource, skillId, t]);

  const chooseFile = (path: string) => { setSelected(path); setPreview(null); setPreviewError(null); };
  const retry = () => { setIndex(null); setPreview(null); setBrowseError(null); setPreviewError(null); setReload(current => current + 1); };
  const toggleItems: AgentToggleItem[] = (toolToggles ?? []).map(toggle => ({
    key: toggle.tool, displayName: toggle.display_name, enabled: toggle.enabled,
    isAvailable: toggle.installed && toggle.globally_enabled, disabled: !toggle.installed || !toggle.globally_enabled,
    badgeLabel: !toggle.installed ? t("mySkills.agentToggleNotInstalled") : !toggle.globally_enabled ? t("mySkills.agentToggleDisabledGlobally") : null,
  }));
  const metadataItems = [
    { label: t("mySkills.sourceType"), value: skill.source_type === "skillssh" ? "skills.sh" : skill.source_type },
    { label: t("mySkills.sourceRef"), value: skill.source_ref },
    { label: t("mySkills.sourceResolved"), value: skill.source_ref_resolved },
    { label: t("mySkills.sourceBranch"), value: skill.source_branch },
    { label: t("mySkills.sourceSubpath"), value: skill.source_subpath },
    { label: t("mySkills.sourceRevision"), value: skill.source_revision },
  ].filter(item => item.value);
  const meta = infoExpanded ? <div id="skill-detail-info" className="max-h-[40vh] overflow-y-auto text-secondary">
    <div className="skill-info-groups">
      <section><h3>{t("skillBrowser.installLocation")}</h3><p className="font-medium">{t("skillBrowser.centralLibrary")}</p><p className="mt-2 font-mono">{skill.central_path}</p></section>
      <section><h3>{t("skillBrowser.sourceLocation")}</h3><dl>{metadataItems.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>
      <section><h3>{t("skillBrowser.deployments")}</h3>{tools && <SyncDots skill={skill} tools={tools} size="sm" includeOrphan />}
        {skill.targets.length ? skill.targets.map(target => <p key={target.id} className="mt-2">{tools?.find(tool => tool.key === target.tool)?.display_name ?? target.tool} · {target.status}<span className="mt-1 block font-mono text-[11px] text-muted">{target.target_path}</span></p>) : <p>{t("skillBrowser.noDeployments")}</p>}
      </section>
      <section><h3>{t("skillBrowser.directoryContents")}</h3><p>{index ? t(index.complete ? "skillBrowser.counts" : "skillBrowser.partialCounts", { files: index.file_count, directories: index.directory_count }) : t("common.loading")}</p><p className="mt-2 text-muted">{t("skillBrowser.includesHidden")}</p>{skill.tags.length > 0 && <p className="mt-2">{skill.tags.join(" · ")}</p>}</section>
    </div>
    {toolToggles && onToggleTool && <AgentToggleSection items={toggleItems} togglingKey={togglingTool} onToggle={onToggleTool} className="mt-3" />}
    {projects && projects.length > 0 && <SkillProjectsSection skill={skill} projects={projects} onChanged={onProjectsChanged} />}
  </div> : undefined;

  return <DetailSheet open title={<span className="flex min-w-0 items-center gap-3"><BookOpen className="shrink-0 text-accent" size={25} /><span className="truncate" title={skill.name}>{skill.name}</span><button type="button" aria-expanded={infoExpanded} aria-controls="skill-detail-info" onClick={() => setInfoExpanded(value => !value)} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12px] font-normal text-muted focus-visible:outline-accent"><Info size={14} />{t("skillBrowser.skillInfo")}<ChevronDown size={12} /></button></span>}
    description={skill.description ? <p className="line-clamp-1 text-[12px] text-muted">{skill.description}</p> : undefined} meta={meta} onClose={onClose} workbench>
    <nav className="flex shrink-0 items-center gap-1 px-6 pb-2" aria-label={t("skillBrowser.modules")}>
      {(["local", "diff", "source"] as const).map(tab => <button key={tab} type="button" aria-pressed={contentTab === tab} onClick={() => setContentTab(tab)}
        className={cn("rounded-md px-3 py-2 text-[12px] font-medium focus-visible:outline-accent", contentTab === tab ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-hover")}>
        {tab === "local" ? t("skillBrowser.localFiles") : t(`mySkills.docTabs.${tab}`)}
      </button>)}
    </nav>
    <div className={contentTab === "local" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {index ? <SkillFileBrowser index={index} selected={selected} onSelect={chooseFile} preview={preview?.path === selected ? preview : null} loading={!!selected && !preview && !previewError} error={previewError} onRetry={retry} />
        : <div className="skill-file-message" role={browseError ? "alert" : "status"}>{browseError ?? t("common.loading")}{browseError && <button onClick={retry}>{t("skillBrowser.reload")}</button>}</div>}
    </div>
    {contentTab !== "local" && <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle p-6">
      {!supportsSource ? <p className="skill-file-message">{t("mySkills.sourceDiffUnavailable")}</p>
        : contentTab === "source" ? sourceDoc ? <><p className="mb-5 text-[12px] text-muted">{sourceDoc.source_label} · {sourceDoc.revision.slice(0, 7)}</p><SkillMarkdown content={sourceDoc.content} /></> : <p className="skill-file-message">{sourceError ?? t("common.loading")}</p>
        : sourceDiff ? <SkillSourceDiffViewer entries={sourceDiff.entries} /> : <p className="skill-file-message">{diffError ?? t("common.loading")}</p>}
    </div>}
  </DetailSheet>;
}
