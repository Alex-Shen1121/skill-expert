import { cn } from "../utils";

interface Props {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/** 34x20 pill switch — the canonical on/off control (see UI spec in CLAUDE.md). */
export function ToggleSwitch({ checked, onChange, disabled, title, className }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "relative h-5 w-[34px] shrink-0 rounded-full outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-accent",
        checked ? "bg-accent-light" : "bg-surface-active",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-all",
          checked ? "left-[16px]" : "left-0.5"
        )}
      />
    </button>
  );
}
