// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { useMultiSelect } from "./useMultiSelect";

type Item = { id: string; active: boolean };

const items: Item[] = [
  { id: "alpha", active: true },
  { id: "beta", active: true },
];

function options(filtered: Item[], filterSignal: string, scopeSignal = "library") {
  return {
    items,
    filtered,
    getKey: (item: Item) => item.id,
    isItemActive: (item: Item) => item.active,
    filterSignal,
    scopeSignal,
  };
}

describe("useMultiSelect", () => {
  it("筛选变化只保留当前可见项，切换范围清空选择并支持 Escape 退出", () => {
    const view = renderHook((props) => useMultiSelect(props), {
      initialProps: options(items, "all"),
    });

    act(() => {
      view.result.current.toggleSelect("alpha");
      view.result.current.toggleSelect("beta");
      view.result.current.setIsMultiSelect(true);
    });
    expect(view.result.current.selectedIds).toEqual(new Set(["alpha", "beta"]));

    view.rerender(options([items[1]], "beta-only"));
    expect(view.result.current.selectedIds).toEqual(new Set(["beta"]));

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(view.result.current.isMultiSelect).toBe(false);
    expect(view.result.current.selectedIds).toEqual(new Set());

    act(() => {
      view.result.current.toggleSelect("beta");
    });
    view.rerender(options(items, "all", "project-2"));
    expect(view.result.current.selectedIds).toEqual(new Set());
  });
});
