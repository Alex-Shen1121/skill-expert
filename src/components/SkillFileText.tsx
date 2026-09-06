import { useTranslation } from "react-i18next";

export function SkillFileText({ text }: { text: string }) {
  const { t } = useTranslation();
  return <div className="skill-file-code">
    <pre aria-hidden="true">{Array.from({ length: text.split("\n").length }, (_, number) => number + 1).join("\n")}</pre>
    <pre aria-label={t("skillBrowser.rawContent")}>{text}</pre>
  </div>;
}
