import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "summary",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface Options {
  active?: boolean;
  onEscape?: () => void;
  focusContainerInitially?: boolean;
}

export function useModalFocusTrap<T extends HTMLElement>({
  active = true,
  onEscape,
  focusContainerInitially = false,
}: Options = {}) {
  const containerRef = useRef<T>(null);

  const focusableElements = useCallback(
    () => Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ),
    [],
  );

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    (focusContainerInitially ? containerRef.current : focusableElements()[0] ?? containerRef.current)?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active, focusContainerInitially, focusableElements]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<T>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape?.();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      containerRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = containerRef.current;
    const focused = document.activeElement;
    const focusIsOutside = !current?.contains(focused);
    if (event.shiftKey && (focused === first || focused === current || focusIsOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (focused === last || focused === current || focusIsOutside)) {
      event.preventDefault();
      first.focus();
    }
  }, [focusableElements, onEscape]);

  return { containerRef, onKeyDown };
}
