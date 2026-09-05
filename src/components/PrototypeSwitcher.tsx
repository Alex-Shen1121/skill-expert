import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router-dom";

const variants = ["A", "B", "C"];

export function PrototypeSwitcher({ label, children }: { label: string; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const current = params.get("variant") ?? "B";
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = (variants.indexOf(current) + (event.key === "ArrowLeft" ? 2 : 1)) % 3;
      setParams(previous => { previous.set("variant", variants[next]); return previous; }, { replace: true });
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [current, setParams]);

  if (!import.meta.env.DEV) return null;
  const move = (step: number) => setParams(previous => {
    previous.set("variant", variants[(variants.indexOf(current) + step + 3) % 3]);
    return previous;
  }, { replace: true });
  return <div className="sf-prototype-switcher" aria-label="原型方案切换">
    <button aria-label="上一个方案" onClick={() => move(-1)}><ChevronLeft size={17} /></button>
    <span className="sf-prototype-mark">交互原型 · 示例数据</span>
    <strong>{label}</strong>
    <button aria-label="下一个方案" onClick={() => move(1)}><ChevronRight size={17} /></button>
    <span className="sf-switcher-divider" />
    {variants.map(key => <button key={key} aria-label={`方案 ${key}`} aria-pressed={key === current} onClick={() => setParams(previous => { previous.set("variant", key); return previous; }, { replace: true })}>{key}</button>)}
    {children}
  </div>;
}
