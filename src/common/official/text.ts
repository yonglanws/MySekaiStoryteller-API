/**
 * 官方剧情文本的字符计数。
 *
 * 官方打字机按正文的 UTF-16 长度推进（每个字两个 WaitForSeconds(0.03)，共 4 帧），
 * 官方正文里的换行（以及富文本标签的每个字符）同样计入。
 *
 * 本工程 `sanitizeDisplayText` 在 30 字宽处插入的排版换行不是官方正文的一部分：
 * 它写成「零宽空格 + 换行」作为标记，计数时两者都跳过。
 */
export const LAYOUT_BREAK_MARKER = '\u200B'

function isLayoutBreak(content: string, index: number): boolean {
  const char = content[index]
  if (char !== '\n' && char !== '\r') return false
  return index > 0 && content[index - 1] === LAYOUT_BREAK_MARKER
}

/** 官方正文字符数（UTF-16 单元）：官方换行计入，排版换行标记不计。 */
export function visibleTextLength(content: string): number {
  let count = 0
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === LAYOUT_BREAK_MARKER) continue
    if (isLayoutBreak(content, i)) continue
    count++
  }
  return count
}

/** 按正文字符数取前缀；排版换行随前一个字符一起显示，但不计数。 */
export function sliceVisibleText(content: string, count: number): string {
  if (count <= 0) return ''
  let visible = 0
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === LAYOUT_BREAK_MARKER || isLayoutBreak(content, i)) continue
    visible++
    if (visible > count) return content.slice(0, i)
  }
  return content
}
