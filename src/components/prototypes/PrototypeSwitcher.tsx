import { useEffect } from "react";
import { ArrowLeft, ArrowRight, FlaskConical } from "lucide-react";

export interface PrototypeVariant {
  key: string;
  name: string;
}

interface PrototypeSwitcherProps {
  variants: PrototypeVariant[];
  current: string;
  onChange: (key: string) => void;
}

export function PrototypeSwitcher({ variants, current, onChange }: PrototypeSwitcherProps) {
  const currentIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );

  const cycle = (direction: -1 | 1) => {
    const nextIndex = (currentIndex + direction + variants.length) % variants.length;
    onChange(variants[nextIndex].key);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        cycle(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        cycle(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (import.meta.env.PROD) return null;

  const active = variants[currentIndex];
  return (
    <div className="fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-700/70 bg-zinc-950/95 p-1.5 text-white shadow-2xl shadow-black/25 backdrop-blur-xl">
      <button
        type="button"
        onClick={() => cycle(-1)}
        className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
        aria-label="上一个原型方案"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div className="flex min-w-[220px] items-center justify-center gap-2 px-3 text-[12px]">
        <FlaskConical className="h-3.5 w-3.5 text-emerald-400" />
        <span className="font-semibold">{active.key}</span>
        <span className="text-zinc-400">{active.name}</span>
      </div>
      <button
        type="button"
        onClick={() => cycle(1)}
        className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
        aria-label="下一个原型方案"
      >
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
