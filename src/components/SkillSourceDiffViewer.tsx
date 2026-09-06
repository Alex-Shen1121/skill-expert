import { useTranslation } from "react-i18next";
import type { SkillBrowserComparison, SkillFilePreview } from "../lib/tauri";
import { DocumentDiffViewer } from "./DocumentDiffViewer";
import { SkillFileText } from "./SkillFileText";

interface Props {
  entry: SkillBrowserComparison | null;
  onlyDiff: boolean;
  original: SkillFilePreview | null;
  updated: SkillFilePreview | null;
  originalError: string | null;
  updatedError: string | null;
  onRetry: () => void;
}

export function SkillSourceDiffViewer({ entry, onlyDiff, original, updated, originalError, updatedError, onRetry }: Props) {
  const { t } = useTranslation();
  if (!entry) return <p className="skill-file-message">{t("skillBrowser.chooseFile")}</p>;
  const reason = entry.reason_code ? t(`skillBrowser.diffReason.${entry.reason_code}`) : entry.reason;
  const permissionChanged = entry.exec_bits_before != null && entry.exec_bits_after != null && entry.exec_bits_before !== entry.exec_bits_after;
  const notice = entry.status === "unchanged" ? "unchangedContent" : entry.status === "not_compared" ? "notComparedContent" : entry.status === "uncomparable" ? "uncomparableContent" : permissionChanged && entry.content_changed === false ? "permissionOnly" : null;
  const snippets = originalError || updatedError ? <div role="alert" className="skill-file-message"><p>{t("skillBrowser.uncomparableContent")}</p>{originalError && originalError !== reason && originalError !== entry.reason && <p>{originalError}</p>}{updatedError && updatedError !== reason && updatedError !== entry.reason && <p>{updatedError}</p>}<button onClick={onRetry}>{t("skillBrowser.reload")}</button></div>
    : notice ? <p className="skill-file-message">{t(`skillBrowser.${notice}`)}</p>
    : !original || !updated ? <p role="status" className="skill-file-message">{t("common.loading")}</p>
    : [original, updated].every(preview => preview.kind === "text" || preview.kind === "missing")
      ? <DocumentDiffViewer original={original.text ?? ""} updated={updated.text ?? ""} />
      : <p className="skill-file-message">{t("skillBrowser.snippetsUnavailable")}</p>;
  return <>
    <div className="skill-diff-summary">{entry.status && <strong>{t(`skillBrowser.diffStatus.${entry.status}`)}</strong>}{reason && <span>{reason}</span>}{entry.reason_code && entry.reason && <span>{entry.reason}</span>}{permissionChanged && <span>{t("skillBrowser.execBits", { before: entry.exec_bits_before!.toString(8).padStart(4, "0"), after: entry.exec_bits_after!.toString(8).padStart(4, "0") })}</span>}</div>
    {onlyDiff ? <div className="p-4">{snippets}</div> : <div className="skill-diff-columns">
      {(["local", "source"] as const).map(side => {
        const preview = side === "local" ? original : updated;
        const error = side === "local" ? originalError : updatedError;
        const metadata = entry[side];
        return <section key={side} aria-label={t(`skillBrowser.diffSide.${side}`)}>
          <h3>{t(`skillBrowser.diffSide.${side}`)}{metadata && <small>{t(`skillBrowser.entryKind.${metadata.kind}`)} · {metadata.size} B</small>}</h3>
          <div className="skill-diff-body">
            {error ? <div role="alert" className="skill-file-message">{error}<button onClick={onRetry}>{t("skillBrowser.reload")}</button></div>
              : !preview ? <p role="status" className="skill-file-message">{t("common.loading")}</p>
              : preview.kind === "text" ? <SkillFileText text={preview.text ?? ""} />
              : <div className="skill-file-message">{preview.message ?? t(`skillBrowser.previewKind.${preview.kind}`)}</div>}
          </div>
        </section>;
      })}
    </div>}
  </>;
}
