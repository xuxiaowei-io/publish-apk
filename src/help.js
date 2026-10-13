/**
 * 帮助文档渲染：把「标题 + 用法 + 分节列表 + 说明」渲染成对齐的文本。
 *
 * 本模块只负责排版，不含任何厂商文案——厂商的帮助内容由各自模块构造后传进来。
 * 中文等全角字符在终端中占两个字符宽度，直接用 String#padEnd 会让描述列错位，
 * 因此这里按「显示宽度」补齐。
 */

/** 占用两个字符宽度的字符（CJK 等全角字符） */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** 计算字符串在终端中的显示宽度 */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    width += WIDE_CHAR.test(char) ? 2 : 1
  }
  return width
}

/** 按显示宽度在右侧补空格 */
function padEndByWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 渲染一组「名称 + 描述」列表，描述列统一对齐 */
function renderEntries(entries) {
  const width = entries.reduce((max, [name]) => Math.max(max, displayWidth(name)), 0) + 2
  return entries
    .map(([name, description]) => `  ${padEndByWidth(name, width)}${description ?? ''}`.trimEnd())
    .join('\n')
}

/**
 * 渲染一份帮助文档。
 *
 * @param {{ title: string, usage: string[], sections: { title: string, entries: [string, string][] }[], notes?: string[] }} doc
 * @returns {string}
 */
export function renderHelp({ title, usage, sections, notes = [] }) {
  const lines = [title, '', '用法:', ...usage.map((line) => `  ${line}`)]
  for (const { title: sectionTitle, entries } of sections) {
    lines.push('', `${sectionTitle}:`, renderEntries(entries))
  }
  if (notes.length > 0) {
    lines.push('', ...notes)
  }
  return lines.join('\n')
}
