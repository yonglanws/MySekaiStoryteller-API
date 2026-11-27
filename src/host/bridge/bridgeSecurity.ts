import crypto from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import type { HostConfig } from '../config'

export const ALLOWED_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST'])
export const SAFE_TEMP_PREFIX_RE = /^[a-zA-Z0-9_-]{1,64}$/
export const SAFE_TEMP_EXT_RE = /^[a-zA-Z0-9]{1,16}$/

export class BridgeSecurityError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 403) {
    super(message)
    this.name = 'BridgeSecurityError'
    this.statusCode = statusCode
  }
}

export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function normalizePathForCompare(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target
}

export function resolveWithExistingRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  const parts: string[] = []
  let current = resolved
  while (true) {
    try {
      const real = fs.realpathSync(current)
      return parts.length ? path.join(real, ...parts.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      parts.push(path.basename(current))
      current = parent
    }
  }
}

export function isStrictlyWithinRoot(targetPath: string, rootDir: string): boolean {
  const rel = path.relative(normalizePathForCompare(rootDir), normalizePathForCompare(targetPath))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function assertContainedPath(
  targetPath: unknown,
  allowedRoots: string[],
  label: string
): string {
  if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) {
    throw new BridgeSecurityError(`Invalid ${label}`, 400)
  }
  const resolved = resolveWithExistingRealpath(targetPath)
  if (!allowedRoots.some((root) => isStrictlyWithinRoot(resolved, root))) {
    throw new BridgeSecurityError(`Path outside allowed workspace/temp root (${label})`, 403)
  }
  return resolved
}

export function defaultAllowedTempRoots(): string[] {
  return Array.from(new Set([resolveWithExistingRealpath(tmpdir()), path.resolve(tmpdir())]))
}

export function resolveContainedTempPath(
  rawPath: string,
  tempRoots: string[] = defaultAllowedTempRoots()
): string | null {
  if (!rawPath || rawPath.includes('\0')) return null
  const resolved = resolveWithExistingRealpath(rawPath)
  return tempRoots.some((root) => isStrictlyWithinRoot(resolved, root)) ? resolved : null
}

export function parseAllowlistedOrigin(
  rawUrl: string | undefined
): { origin: string; basePath: string } | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const basePath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return { origin: parsed.origin, basePath }
  } catch {
    return null
  }
}

export function isAllowedProxyTarget(
  rawUrl: unknown,
  allowlist: Array<{ origin: string; basePath: string }>
): URL | null {
  if (typeof rawUrl !== 'string' || !rawUrl) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  for (const entry of allowlist) {
    if (parsed.origin !== entry.origin) continue
    if (
      entry.basePath === '/' ||
      parsed.pathname === entry.basePath.slice(0, -1) ||
      parsed.pathname.startsWith(entry.basePath)
    ) {
      return parsed
    }
  }
  return null
}

/** 临时名随机后缀：避免同毫秒并发导出共用同一路径 */
export function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

function isAllowedCloudOnlyResourceRelPath(relPosix: string): boolean {
  const clean = relPosix.replace(/^\/+/, '').toLowerCase()
  return (
    clean.startsWith('audio/bgm/cloud/') ||
    clean.startsWith('audio/se/cloud/') ||
    clean.startsWith('cloud/') ||
    clean.startsWith('inapp/')
  )
}

/** 创建 Bridge 音频路径解析器（供路由与单元测试复用）；cloudOnly=true 时拒绝非 cloud/ 的 resources 音频路径。 */
export function createOptionalAudioPathResolver(
  config: Pick<HostConfig, 'paths' | 'bgm' | 'assets'>,
  allowedTempRoots: string[] = defaultAllowedTempRoots()
): (rawPath: unknown) => string | undefined {
  const resourceRoot = config.paths?.resources
    ? resolveWithExistingRealpath(config.paths.resources)
    : ''
  const customBgmPath = config.bgm?.path ? resolveWithExistingRealpath(config.bgm.path) : ''
  const allowedResourceRoots = Array.from(
    new Set([...(resourceRoot ? [resourceRoot] : []), ...allowedTempRoots])
  )

  return (rawPath: unknown): string | undefined => {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return undefined
    let candidate = rawPath.trim()
    if (/^https?:\/\//i.test(candidate)) {
      try {
        candidate = new URL(candidate).pathname
      } catch {
        return undefined
      }
    }
    if (candidate.startsWith('/resources/')) {
      if (!resourceRoot) return undefined
      candidate = path.join(resourceRoot, candidate.slice('/resources/'.length))
    } else if (!path.isAbsolute(candidate)) {
      if (!resourceRoot) return undefined
      const stripped = candidate
        .replace(/^\/+/, '')
        .replace(/^resources\/builtin\//, '')
        .replace(/^resources\//, '')
      candidate = path.join(resourceRoot, stripped)
    }
    const resolvedCandidate = resolveWithExistingRealpath(candidate)
    if (config.assets?.cloudOnly && resourceRoot) {
      const relToResource = path.relative(
        normalizePathForCompare(resourceRoot),
        normalizePathForCompare(resolvedCandidate)
      )
      if (
        !relToResource ||
        (!relToResource.startsWith('..') &&
          !path.isAbsolute(relToResource) &&
          !isAllowedCloudOnlyResourceRelPath(relToResource.replace(/\\/g, '/')))
      ) {
        return undefined
      }
    }
    if (
      customBgmPath &&
      normalizePathForCompare(resolvedCandidate) === normalizePathForCompare(customBgmPath)
    ) {
      return fs.existsSync(resolvedCandidate) ? resolvedCandidate : undefined
    }
    try {
      const safe = assertContainedPath(candidate, allowedResourceRoots, 'audio resource path')
      return fs.existsSync(safe) ? safe : undefined
    } catch {
      return undefined
    }
  }
}

/** 桥接安全中间件：剥离全局 CORS、限制同源、验证 RenderPool 会话令牌 */
export function createBridgeSecurityMiddleware(bridgeToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.removeHeader('Access-Control-Allow-Origin')
    res.removeHeader('Access-Control-Allow-Methods')
    res.removeHeader('Access-Control-Allow-Headers')

    const origin = req.headers.origin
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (!originHost || !req.headers.host || originHost !== req.headers.host) {
        res.status(403).json({ ok: false, error: 'Cross-origin bridge requests are forbidden' })
        return
      }
    }

    if (bridgeToken) {
      const headerToken = req.headers['x-mss-bridge-token']
      const authHeader = req.headers.authorization
      const bearerToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : ''
      const queryToken = typeof req.query.token === 'string' ? req.query.token : ''
      const provided =
        (typeof headerToken === 'string' ? headerToken : '') || bearerToken || queryToken
      if (!provided || !timingSafeTokenEqual(provided, bridgeToken)) {
        res.status(401).json({ ok: false, error: 'Unauthorized bridge request' })
        return
      }
    }

    next()
  }
}
