/**
 * 官方剧情文本的字符计数。
 *
 * `sanitizeDisplayText` 会在 26 字宽处插入 `\n`，但官方打字机只按可见字符推进
 * （每个字两个 WaitForSeconds(0.03)，共 4 帧）。换行是排版结果，不能计入时长。
 */
export function visibleTextLength(content: string): number {
  let count = 0
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char !== '\n' && char !== '\r') count++
  }
  return count
}

/** 按可见字符数取前缀；换行随前一个可见字符一起显示，但不计数。 */
export function sliceVisibleText(content: string, count: number): string {
  if (count <= 0) return ''
  let visible = 0
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char !== '\n' && char !== '\r') {
      visible++
      if (visible > count) return content.slice(0, i)
    }
  }
  return content
}
