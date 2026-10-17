import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../lib/tauri";

export function StartupGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<api.StartupFailure | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    let active = true;
    api.getStartupFailure().then((result) => { if (active) setFailure(result); }).catch(() => {
      if (active) setFailure({ stage: "startup_status", code: "unavailable", setting: null, retryable: true, diagnostics: "Startup status unavailable" });
    });
    return () => { active = false; };
  }, []);
  if (failure === undefined) return <main role="status" className="p-8">{t("common.loading")}</main>;
  if (failure === null) return children;
  const restart = async () => {
    setBusy(true);
    try { await api.restartApp(); }
    catch { setFeedback(t("agentRegistration.actionFailed")); setBusy(false); }
  };
  const copy = async () => {
    try { await writeText(failure.diagnostics); setFeedback(t("agentRegistration.copied")); }
    catch { setFeedback(t("agentRegistration.copyFailed")); }
  };
  return <main className="mx-auto max-w-2xl p-8 space-y-5">
    <h1 className="text-xl font-semibold">{t("agentRegistration.startupTitle")}</h1>
    <p>{t("agentRegistration.startupHelp")}</p>
    <dl className="space-y-2 break-words"><dt>{t("agentRegistration.stage")}</dt><dd>{failure.stage}</dd>
      <dt>{t("agentRegistration.configuration")}</dt><dd>{failure.setting ?? "—"}</dd>
      <dt>{t("agentRegistration.reason")}</dt><dd>{failure.code}</dd></dl>
    <div className="flex flex-wrap gap-3">
      <button disabled={busy} onClick={restart} className="rounded-md border border-border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{t("agentRegistration.restart")}</button>
      <button onClick={copy} className="rounded-md border border-border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{t("agentRegistration.copy")}</button>
      <button onClick={() => api.appExit().catch(() => setFeedback(t("agentRegistration.actionFailed")))} className="rounded-md border border-border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{t("agentRegistration.exit")}</button>
    </div>
    {feedback && <p role="status">{feedback}</p>}
  </main>;
}
