/** 前端只接受后端已经净化并重新编码的 PNG，不触发文件或网络读取。 */
export function isSafePluginImageDataUrl(value: string | null): value is string {
  return value?.startsWith("data:image/png;base64,") ?? false;
}

export function isSafePluginImageUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
