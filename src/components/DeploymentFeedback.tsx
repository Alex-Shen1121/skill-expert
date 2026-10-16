import { useTranslation } from "react-i18next";
import type { DeploymentReport } from "../lib/tauri";

export function DeploymentFeedback({ report }: { report: DeploymentReport }) {
  const { t } = useTranslation();
  return <div className="mt-3 space-y-2 text-sm" role={report.state === "complete" || report.state === "not_run" ? "status" : "alert"}>
    <p>{t(report.operation === "remove" ? "agentRegistration.removalScope" : "agentRegistration.scope")}</p>
    <p className="font-medium">{t(`agentRegistration.${report.state}`)}</p>
    {report.reason && <p>{t(`agentRegistration.${report.reason}`)}</p>}
    {report.total === null && <p>{t("agentRegistration.unknownTotal")}</p>}
    <ul className="space-y-2">
      {report.targets.map((target, i) => <li key={`${target.skill_id}:${target.tool}:${i}`} className="break-all">
        <strong>{target.tool}</strong> · {target.skill_id}<br />
        <code>{target.target_path}</code><br />
        {t(`agentRegistration.${target.outcome}`)}{target.message && <> — {target.message}</>}
      </li>)}
      {report.issues.map((issue, i) => <li key={i} className="break-words">{issue.stage} · {issue.code} · {issue.tool} · {issue.target_path} — {issue.message}</li>)}
    </ul>
  </div>;
}
