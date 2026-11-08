import * as fs from 'node:fs'
import path from 'node:path'
import { formatDiagnosticsText, sanitizeDiagnostics } from '../common/export/diagnosticsFormat'
import type { ExportDiagnostics } from '../common/types/ExportDiagnostics'

export interface WrittenExportLogs {
  jsonPath: string
  textPath: string
  reportPath: string
}

function formatExportReport(videoPath: string, diagnostics: ExportDiagnostics): string {
  const lines: string[] = []
  const { summary, export: meta, plan } = diagnostics
  lines.push('=== MySekaiStoryteller export report ===')
  lines.push(`video: ${path.basename(videoPath)}`)
  lines.push(`generated: ${diagnostics.generatedAt}`)
  lines.push(`mode: ${meta.mode} ${meta.width}x${meta.height} ${meta.fps}fps`)
  lines.push(`duration: ${Math.round(meta.durationMs)}ms frames=${meta.frameCount}`)
  lines.push(
    `snippets: ${summary.snippets} talks=${summary.talks} appears=${summary.layoutAppears} ` +
      `clears=${summary.layoutClears}`
  )
  lines.push(
    `timing: planned=${summary.plannedDurationMs}ms actual=${summary.actualDurationMs}ms ` +
      `avgAbsDrift=${summary.avgAbsDriftMs}ms`
  )
  if (plan) {
    lines.push(
      `frame plan: ${plan.totalFrames} frames @ ${plan.fps}fps (${Math.round(plan.totalMs)}ms)`
    )
  }
  lines.push('')
  lines.push('--- approximations / unsupported ---')
  if (diagnostics.approximations?.length) {
    for (const item of diagnostics.approximations) lines.push(`- ${item}`)
  } else {
    lines.push('(none reported)')
  }
  lines.push('')
  lines.push(`--- anomalies (${diagnostics.anomalies.length}) ---`)
  if (diagnostics.anomalies.length === 0) lines.push('(none)')
  else for (const anomaly of diagnostics.anomalies) lines.push(`- ${anomaly}`)
  lines.push('')
  lines.push(
    'Full per-snippet/per-motion trace: see the .log and .log.json files next to this report.'
  )
  return lines.join('\n')
}

/** 把渲染端返回的 diagnostics 写到视频同目录：`.log.json`、`.log` 与 `.report.txt`。 */
export function writeExportDiagnostics(
  outputPath: string,
  diagnostics: ExportDiagnostics
): WrittenExportLogs {
  const base = outputPath.replace(/\.mp4$/i, '')
  const jsonPath = `${base}.log.json`
  const textPath = `${base}.log`
  const reportPath = `${base}.report.txt`
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(sanitizeDiagnostics(diagnostics), null, 2)}\n`,
    'utf8'
  )
  fs.writeFileSync(textPath, `${formatDiagnosticsText(diagnostics)}\n`, 'utf8')
  fs.writeFileSync(reportPath, `${formatExportReport(outputPath, diagnostics)}\n`, 'utf8')
  return { jsonPath, textPath, reportPath }
}
