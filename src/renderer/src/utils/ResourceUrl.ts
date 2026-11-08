/**
 * 资源 URL 构造 —— 全仓唯一的资源寻址入口。
 *
 * 宿主把资源根（config.paths.resources）固定挂在 `/resources/` 路由下，
 * 故事 JSON 内的 models/、images/、voices/ 相对路径以及 BGM 配置路径
 * 都通过这里拼成同源 URL。
 */

/** 资源根 URL（与宿主 staticRoutes 的挂载点保持一致） */
export const RESOURCE_BASE = '/resources'

/** 资源根下的相对路径 → 同源 URL（subPath 无需以 / 开头） */
export function resourceUrl(subPath: string): string {
  return `${RESOURCE_BASE}/${subPath.replace(/^\/+/, '')}`
}

/**
 * BGM 路径解析（三态）：
 * - http(s) 绝对 URL → 原样
 * - 以 / 开头的路径 → 原样（视为站内绝对路径）
 * - 其余 → 视为资源根相对路径（兼容旧配置里的 'resources/builtin/...' 前缀）
 */
export function resolveBgmUrl(bgmPath: string): string {
  if (/^https?:\/\//i.test(bgmPath) || bgmPath.startsWith('/')) {
    return bgmPath
  }
  const stripped = bgmPath.replace(/^resources\/builtin\//, '').replace(/^resources\//, '')
  return resourceUrl(stripped)
}

/** SE 路径解析，规则与 BGM 一致。 */
export function resolveSeUrl(sePath: string): string {
  return resolveBgmUrl(sePath)
}
