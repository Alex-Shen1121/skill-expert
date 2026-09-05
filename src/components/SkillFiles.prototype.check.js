// 一次性原型自检：打开 B 后运行 agent-browser eval --stdin < src/components/SkillFiles.prototype.check.js。
// 只操作原型中的只读文件浏览器；验证完成后保留在差异的完整内容视图。
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const click = async element => { assert(element, "缺少预期控件"); element.click(); await settle(); };
  const button = label => [...document.querySelectorAll(".sf-prototype button")].find(element => element.textContent.trim() === label);
  const module = async label => {
    const tab = [...document.querySelectorAll(".sf-content-tabs button")].find(element => element.textContent.startsWith(label));
    await click(tab);
    for (let attempt = 0; tab.getAttribute("aria-pressed") !== "true" && attempt < 30; attempt++) await settle();
    assert(tab.getAttribute("aria-pressed") === "true", "内容模块未完成切换");
    while (document.querySelector('.sf-file-row[aria-expanded="false"]')) await click(document.querySelector('.sf-file-row[aria-expanded="false"]'));
  };
  const paths = () => [...document.querySelectorAll(".sf-file-row")].map(element => element.getAttribute("aria-label"));
  const choose = path => click(document.querySelector(`.sf-file-row[aria-label="${path}"]`));
  const text = selector => document.querySelector(selector)?.textContent ?? "";
  const cases = [];

  await module("本地文件");
  const local = paths();
  assert(local.length === 24 && local.includes("references/legacy-notes.md") && !local.includes("references/checklist.md"), "本地目录不完整");
  await choose("scripts/export_markdown.py");
  assert(text(".sf-reader").includes('content.strip() + "\\n"'), "本地脚本版本不正确");
  cases.push("本地 16 个文件、8 个目录及原始脚本");

  await module("来源");
  const source = paths();
  assert(source.length === 24 && source.includes("references/checklist.md") && !source.includes("references/legacy-notes.md"), "来源目录不完整");
  assert(text(".sf-reader").includes('content.replace("\\r\\n", "\\n")'), "来源未保留选中路径或内容不正确");
  await choose("SKILL.md");
  await click(button("原文"));
  assert(text(".sf-reader").includes("version: 1.3.0"), "来源入口文档不是来源版本");
  cases.push("来源完整目录、对应脚本与入口原文");

  await module("差异");
  const union = paths();
  assert(union.length === 25 && [...new Set([...local, ...source])].every(path => union.includes(path)), "差异目录不是两边完整并集");
  await choose("config.json");
  assert(text(".sf-compare-status") === "未变化", "未变化文件状态错误");
  assert(text('[aria-label="当前安装完整内容"] pre') === text('[aria-label="来源完整内容"] pre') && text('[aria-label="来源完整内容"] pre').includes("include_sources"), "未展示未变化文件完整内容");
  for (const [path, status, missing] of [["references/checklist.md", "新增", "当前安装完整内容"], ["references/legacy-notes.md", "删除", "来源完整内容"]]) {
    await choose(path);
    assert(text(".sf-compare-status") === status && text(`[aria-label="${missing}"]`).includes("此版本中没有该文件"), `${path} 的单侧缺失状态错误`);
  }
  await choose(".gitignore");
  assert(text(".sf-compare-status") === "不比较" && text('[aria-label="当前安装完整内容"] pre').includes("__pycache__/"), "隐藏项未保留原文");
  await choose("restricted.txt");
  assert(text(".sf-compare-status") === "无法比较" && text(".sf-reader").includes("没有读取权限"), "无法读取状态丢失");
  await choose("assets/cover.png");
  assert(text(".sf-reader").includes("二进制文件"), "二进制文件被遗漏");
  await choose("assets/archive.json");
  assert(text(".sf-reader").includes("超过预览大小上限"), "超大文件被遗漏");
  await choose("scripts/export_markdown.py");
  assert(text('[aria-label="当前安装完整内容"] pre').includes("if __name__") && text('[aria-label="来源完整内容"] pre').includes('content.replace("\\r\\n", "\\n")'), "修改文件缺少完整两侧内容");
  await click(button("仅差异"));
  assert(text(".sf-reader").includes("content.replace"), "差异片段未呈现修改");
  await click(button("完整内容"));
  cases.push("差异 17 个文件并集、完整双栏、变化片段及特殊文件状态");
  await click(document.querySelector('[aria-label="折叠所有目录"]'));
  await click(document.querySelector('[aria-label="只看变化文件"]'));
  const changed = paths();
  assert(changed.length === 6 && ["SKILL.md", "scripts", "scripts/export_markdown.py", "references", "references/checklist.md", "references/legacy-notes.md"].every(path => changed.includes(path)), "变化筛选未保留全部变化文件及父目录");
  assert(document.querySelector('[aria-label="只看变化文件"]').getAttribute("aria-pressed") === "true" && text(".sf-tree-footer").includes("4 个文件 · 2 个目录"), "变化筛选状态或数量错误");
  const search = document.querySelector('[aria-label="查找文件"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, "config");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  assert(paths().length === 0 && text(".sf-tree").includes("没有匹配的文件"), "搜索未与变化筛选取交集");
  await click(document.querySelector('[aria-label="清除文件查找"]'));
  await module("来源");
  assert(paths().length === 24 && !document.querySelector('[aria-label="只看变化文件"]'), "变化筛选影响了来源目录");
  await module("差异");
  assert(paths().length === 6, "返回差异时筛选状态丢失");
  await click(document.querySelector('[aria-label="只看变化文件"]'));
  await module("差异");
  assert(paths().length === 25, "关闭变化筛选没有恢复完整目录");
  cases.push("变化文件快速筛选、父目录展开、跨模块隔离和关闭恢复");
  return { 结果: "通过", 检查项: cases };
})()
