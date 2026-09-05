/** 前端只接受后端已经净化并重新编码的 PNG，不触发文件或网络读取。 */
export function isSafePluginImageDataUrl(value: string | null): value is string {
  return value?.startsWith("data:image/png;base64,") ?? false;
}
