import type { ExportDiagnostics } from '../types/ExportDiagnostics'

function toSerializable(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…`
    if (typeof value === 'bigint') return value.toString()
    return value
  }
  if (seen.has(value)) return '[circular]'
  if (depth > 6) return '[depth-limit]'
  seen.add(value)
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.slice(0, 4000) }
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => toSerializable(item, seen, depth + 1))
  }
  if (value instanceof Map) {
    return Array.from(value.entries())
      .slice(0, 500)
      .map(([key, item]) => [
        toSerializable(key, seen, depth + 1),
        toSerializable(item, seen, depth + 1)
      ])
  }
  if (value instanceof Set) {
    return Array.from(value.values())
      .slice(0, 500)
      .map((item) => toSerializable(item, seen, depth + 1))
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'function') continue
    result[key] = toSerializable(item, seen, depth + 1)
  }
  return result
}

export function sanitizeDiagnostics<T>(value: T): T {
  return toSerializable(value) as T
}

export function formatDiagnosticsText(report: ExportDiagnostics): string {
  const lines: string[] = []
  const { summary, export: meta } = report
  lines.push('=== MySekaiStoryteller export diagnostics ===')
  lines.push(`generated: ${report.generatedAt}`)
  lines.push(
    `mode=${meta.mode} ${meta.width}x${meta.height} ${meta.fps}fps frames=${meta.frameCount} ` +
      `duration=${Math.round(meta.durationMs)}ms outputSize=${meta.outputSize ?? 'n/a'}`
  )
  if (meta.timings) {
    lines.push(
      `timings: ${Object.entries(meta.timings)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')}`
    )
  }
  lines.push(
    `snippets=${summary.snippets} talks=${summary.talks} planned=${summary.plannedDurationMs}ms ` +
      `actual=${summary.actualDurationMs}ms avgAbsDrift=${summary.avgAbsDriftMs}ms`
  )
  lines.push(
    `tts=${summary.ttsLines} lines/${summary.ttsTotalMs}ms motionStarts=${summary.motionStarts} ` +
      `motionInterrupts=${summary.motionInterrupts} appears=${summary.layoutAppears} clears=${summary.layoutClears}`
  )
  if (report.plan) {
    lines.push(
      `frame plan: ${report.plan.totalFrames} frames @ ${report.plan.fps}fps = ${Math.round(report.plan.totalMs)}ms`
    )
  }
  lines.push('')
  lines.push('--- snippets ---')
  for (const snippet of report.snippets) {
    const head =
      `[${String(snippet.index).padStart(3, '0')}] ${snippet.type.padEnd(20)} ` +
      `plan=${snippet.plannedStartMs}+${snippet.plannedDurationMs}ms ` +
      `actual=${snippet.actualStartMs ?? '?'}+${snippet.actualDurationMs ?? '?'}ms ` +
      `drift=${snippet.driftMs ?? '?'}ms`
    const detail = [
      snippet.speaker ? `speaker=${snippet.speaker}` : '',
      snippet.ttsDurationMs ? `tts=${snippet.ttsDurationMs}ms` : '',
      snippet.content ? `text="${snippet.content.replace(/\n/g, ' / ')}"` : ''
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`${head}${detail ? ` ${detail}` : ''}`)
    for (const action of snippet.actions) {
      lines.push(
        `      action at=${action.at} cue=${action.cueAtMs}ms model=${action.modelId}` +
          `${action.motion ? ` motion=${action.motion}` : ''}${
            action.facial ? ` facial=${action.facial}` : ''
          }`
      )
    }
  }
  if (report.plan) {
    lines.push('')
    lines.push('--- frame plan ---')
    for (const entry of report.plan.entries) {
      lines.push(
        `[${String(entry.index).padStart(3, '0')}] ${entry.type.padEnd(20)} ` +
          `frames=${entry.startFrame}..${entry.endFrame} (${entry.durationFrames}f${
            entry.blocking ? '' : ', background'
          })`
      )
      if (entry.talk) {
        lines.push(
          `      talk window=${entry.talk.windowOpenFrames}f ` +
            `typing=${entry.talk.typingStartFrame}..${entry.talk.typingEndFrame} ` +
            `voiceEnd=${entry.talk.voiceEndFrame ?? 'n/a'} gateEnd=${entry.talk.gateEndFrame}`
        )
      }
      if (entry.layout) {
        lines.push(
          `      layout ${entry.layout.kind} fade=${entry.layout.fadeStartFrame ?? 'n/a'}..${
            entry.layout.fadeEndFrame ?? 'n/a'
          } moveEnd=${entry.layout.moveEndFrame}`
        )
      }
      if (entry.actions.length > 0) {
        lines.push(
          `      cues ${entry.actions
            .map(
              (action) => `f${action.frame}@${action.at}:${action.motion ?? action.facial ?? '?'}`
            )
            .join(' ')}`
        )
      }
    }
  }
  lines.push('')
  lines.push('--- motion trace ---')
  for (const event of report.motions) {
    lines.push(
      `[${String(event.seq).padStart(4, '0')}] snippet=${event.snippetIndex} model=${event.modelId} ` +
        `ch=${event.channel} ${event.event.padEnd(11)} ${event.name}` +
        `${event.loadMs !== undefined ? ` load=${Math.round(event.loadMs)}ms` : ''}` +
        `${event.playedMs !== undefined ? ` played=${Math.round(event.playedMs)}ms` : ''}` +
        `${event.clipDurationMs ? ` clip=${Math.round(event.clipDurationMs)}ms` : ''}` +
        `${event.fadeMs !== undefined ? ` fade=${Math.round(event.fadeMs)}ms` : ''}` +
        `${event.previous ? ` previous=${event.previous}` : ''}` +
        `${event.reason ? ` reason=${event.reason}` : ''}`
    )
  }
  if (report.approximations?.length) {
    lines.push('')
    lines.push('--- approximations ---')
    for (const item of report.approximations) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('--- anomalies ---')
  if (report.anomalies.length === 0) lines.push('(none)')
  else for (const anomaly of report.anomalies) lines.push(`- ${anomaly}`)
  lines.push('')
  lines.push(`--- logs (${report.logs.length}) ---`)
  for (const log of report.logs) {
    const data = log.data === undefined ? '' : ` ${JSON.stringify(sanitizeDiagnostics(log.data))}`
    lines.push(`[${log.seq}] ${log.level} ${log.module}: ${log.message}${data}`)
  }
  return lines.join('\n')
}
