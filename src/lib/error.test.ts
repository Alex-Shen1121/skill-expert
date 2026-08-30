import { describe, expect, it } from "vitest";
import { getErrorKind, getErrorMessage, isAppError } from "./error";

describe("结构化错误", () => {
  it("识别带冲突路径的目标拒绝错误", () => {
    const error = {
      kind: "target_conflict",
      message: "目标路径不是受管部署",
      details: {
        conflicts: [{ path: "/tmp/skills/demo", reason: "不是受管部署" }],
      },
    };

    expect(isAppError(error)).toBe(true);
    expect(getErrorKind(error)).toBe("target_conflict");
    expect(getErrorMessage(error, "后备文案")).toBe("目标路径不是受管部署");
  });

  it("继续拒绝未知错误种类", () => {
    expect(isAppError({ kind: "unknown", message: "未知" })).toBe(false);
  });
});
