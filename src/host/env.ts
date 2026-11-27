import fs from 'node:fs'
import path from 'node:path'

export interface LoadDotEnvOptions {
  /** Target environment map (defaults to process.env; injectable for unit tests). */
  env?: NodeJS.ProcessEnv
  /** Optional explicit .env path override (takes precedence over MSS_ENV_FILE). */
  envFile?: string
}

export interface LoadDotEnvResult {
  path: string
  loaded: boolean
  loadedKeys: string[]
}

function resolveDefaultRootDir(): string {
  const derived = path.resolve(__dirname, '..', '..')
  if (fs.existsSync(path.join(derived, 'package.json'))) {
    return derived
  }
  return path.resolve(process.cwd())
}

function parseDoubleQuotedValue(raw: string): string {
  let out = ''
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === 'n') {
        out += '\n'
        i += 1
        continue
      }
      if (next === 'r') {
        out += '\r'
        i += 1
        continue
      }
      if (next === 't') {
        out += '\t'
        i += 1
        continue
      }
      if (next === '"' || next === '\\' || next === '$') {
        out += next
        i += 1
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      return out
    }
    out += ch
  }
  return out
}

function parseSingleQuotedValue(raw: string): string {
  const closeIdx = raw.indexOf("'", 1)
  if (closeIdx === -1) {
    return raw.slice(1)
  }
  return raw.slice(1, closeIdx)
}

function parseUnquotedValue(raw: string): string {
  const commentIdx = raw.indexOf('#')
  const slice = commentIdx === -1 ? raw : raw.slice(0, commentIdx)
  return slice.trim()
}

/**
 * Zero-dependency `.env` parser.
 * Supports:
 * - `KEY=VALUE`, CRLF/LF line endings, optional UTF-8 BOM
 * - optional `export ` prefix
 * - single- and double-quoted values (with `\n`, `\r`, `\t`, `\"`, `\\` inside double quotes)
 * - inline `#` comments outside quotes
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const cleaned = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const lines = cleaned.split(/\r?\n/)

  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart()
    if (!trimmed || trimmed.startsWith('#')) continue

    const withoutExport = trimmed.startsWith('export') ? trimmed.replace(/^export\s+/, '') : trimmed
    const match = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const key = match[1]
    const rawVal = match[2]
    let value: string
    if (rawVal.startsWith('"')) {
      value = parseDoubleQuotedValue(rawVal)
    } else if (rawVal.startsWith("'")) {
      value = parseSingleQuotedValue(rawVal)
    } else {
      value = parseUnquotedValue(rawVal)
    }
    result[key] = value
  }

  return result
}

/**
 * Load `.env` into `process.env` without overwriting existing variables
 * (shell / Docker / systemd environment always wins).
 *
 * File path resolution order:
 * 1. `options.envFile`
 * 2. `env.MSS_ENV_FILE` (relative paths resolved against `rootDir`)
 * 3. `<rootDir>/.env`
 */
export function loadDotEnv(rootDir?: string, options?: LoadDotEnvOptions): LoadDotEnvResult {
  const env = options?.env ?? process.env
  const baseDir = rootDir ? path.resolve(rootDir) : resolveDefaultRootDir()
  const override = (options?.envFile ?? env.MSS_ENV_FILE)?.trim()
  const envPath = override ? path.resolve(baseDir, override) : path.join(baseDir, '.env')

  try {
    if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
      return { path: envPath, loaded: false, loadedKeys: [] }
    }
  } catch {
    return { path: envPath, loaded: false, loadedKeys: [] }
  }

  const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf-8'))
  const loadedKeys: string[] = []

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value
      loadedKeys.push(key)
    }
  }

  return { path: envPath, loaded: true, loadedKeys }
}
