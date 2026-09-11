import { useEffect, useMemo, useState } from "react";

interface UseMultiSelectOptions<T> {
  items: T[];
  filtered: T[];
  getKey: (item: T) => string;
  isItemActive: (item: T) => boolean;
  /** 当前搜索、标签和来源筛选状态的序列化值。 */
  filterSignal: string;
  /** 当前列表范围，例如项目 ID 或 Agent key。 */
  scopeSignal?: string;
  /** 弹窗打开时关闭，交由弹窗先处理 Escape。 */
  escapeEnabled?: boolean;
}

export function useMultiSelect<T>({
  items,
  filtered,
  getKey,
  isItemActive,
  filterSignal,
  scopeSignal = "",
  escapeEnabled = true,
}: UseMultiSelectOptions<T>) {
  const [isMultiSelect, setIsMultiSelect] = useState(false);
  const [rawSelectedIds, setRawSelectedIds] = useState(new Set<string>());

  // 在列表状态变化的同一次渲染中调整选择，避免异步 effect 留下过期选择。
  const [prevScope, setPrevScope] = useState(scopeSignal);
  const [prevFilter, setPrevFilter] = useState(filterSignal);
  let selectionAdjusted = false;
  if (prevScope !== scopeSignal) {
    setPrevScope(scopeSignal);
    setPrevFilter(filterSignal);
    if (rawSelectedIds.size > 0) setRawSelectedIds(new Set<string>());
    selectionAdjusted = true;
  } else if (prevFilter !== filterSignal) {
    setPrevFilter(filterSignal);
    if (rawSelectedIds.size > 0) {
      const visible = new Set(filtered.map(getKey));
      const pruned = new Set([...rawSelectedIds].filter((key) => visible.has(key)));
      if (pruned.size !== rawSelectedIds.size) setRawSelectedIds(pruned);
    }
    selectionAdjusted = true;
  }

  // 项目或其他地方删除条目后，清除已不存在的 key，避免工具栏计数失真。
  const selectedIds = useMemo(() => {
    if (rawSelectedIds.size === 0) return rawSelectedIds;
    const existing = new Set(items.map(getKey));
    const live = new Set([...rawSelectedIds].filter((key) => existing.has(key)));
    return live.size === rawSelectedIds.size ? rawSelectedIds : live;
    // getKey 通常由调用方内联创建，实际依赖由 items 和选择集合驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rawSelectedIds]);

  // 将派生清理结果写回原始选择，防止 key 被后续新条目复用。
  if (!selectionAdjusted && selectedIds !== rawSelectedIds) {
    setRawSelectedIds(selectedIds);
  }

  const toggleSelect = (key: string) => {
    setRawSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isAllSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(getKey(s)));

  const anyDisabled = items
    .filter((s) => selectedIds.has(getKey(s)))
    .some((s) => !isItemActive(s));

  const handleSelectAll = () => {
    setRawSelectedIds(
      isAllSelected ? new Set<string>() : new Set(filtered.map(getKey))
    );
  };

  const exitMultiSelect = () => {
    setIsMultiSelect(false);
    setRawSelectedIds(new Set<string>());
  };

  // 多选模式下允许 Escape 退出，但输入框和文本域仍保留原生编辑语义。
  useEffect(() => {
    if (!isMultiSelect || !escapeEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setIsMultiSelect(false);
      setRawSelectedIds(new Set<string>());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMultiSelect, escapeEnabled]);

  return {
    isMultiSelect,
    setIsMultiSelect,
    selectedIds,
    toggleSelect,
    isAllSelected,
    anyDisabled,
    handleSelectAll,
    exitMultiSelect,
  };
}
