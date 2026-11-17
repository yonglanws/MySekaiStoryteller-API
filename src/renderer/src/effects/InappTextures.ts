import { BaseTexture, Texture } from 'pixi.js'

export const INAPP_ASSET_BASE = '/resources/inapp/jp-7.0.0'

const textureCache = new Map<string, Promise<Texture | null>>()
const resolvedTextures = new Map<string, Texture | null>()

export function inappUrl(relPath: string): string {
  return `${INAPP_ASSET_BASE}/${relPath.replace(/^\/+/, '')}`
}

export function isTextureUsable(tex: Texture | null | undefined): tex is Texture {
  return Boolean(tex && tex.valid && tex.baseTexture && tex.baseTexture.valid)
}

export function getCachedInappTexture(relPath: string): Texture | null {
  const tex = resolvedTextures.get(relPath) ?? null
  if (!tex) return null
  if (!isTextureUsable(tex)) {
    resolvedTextures.delete(relPath)
    textureCache.delete(relPath)
    return null
  }
  return tex
}

export function resetInappTextureCache(): void {
  for (const tex of resolvedTextures.values()) {
    if (isTextureUsable(tex)) {
      try {
        tex.destroy(true)
      } catch {
        // ignore double-destroy across worker lifecycle resets
      }
    }
  }
  textureCache.clear()
  resolvedTextures.clear()
}

/**
 * 异步尝试加载本地缓存的官方 `inapp` 贴图；若离线未下载或处于纯 DOM/单元测试环境则返回 null，
 * 调用方使用内置矢量兜底绘制。
 */
export function loadInappTexture(relPath: string): Promise<Texture | null> {
  if (resolvedTextures.has(relPath)) {
    const resolved = resolvedTextures.get(relPath) ?? null
    if (resolved !== null && !isTextureUsable(resolved)) {
      resolvedTextures.delete(relPath)
      textureCache.delete(relPath)
    } else if (resolved !== null) {
      return Promise.resolve(resolved)
    }
  }

  const existing = textureCache.get(relPath)
  if (existing) {
    return existing.then((tex) => {
      if (tex && !isTextureUsable(tex)) {
        if (textureCache.get(relPath) === existing) textureCache.delete(relPath)
        if (resolvedTextures.get(relPath) === tex) resolvedTextures.delete(relPath)
        return loadInappTexture(relPath)
      }
      return tex
    })
  }

  const promise = (async (): Promise<Texture | null> => {
    if (typeof Image === 'undefined' || typeof fetch === 'undefined') {
      resolvedTextures.set(relPath, null)
      return null
    }
    const url = inappUrl(relPath)
    try {
      const resp = await fetch(url, { method: 'HEAD' })
      if (!resp.ok) {
        resolvedTextures.set(relPath, null)
        return null
      }
      const tex = await new Promise<Texture | null>((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          try {
            const base = new BaseTexture(img)
            resolve(new Texture(base))
          } catch {
            resolve(null)
          }
        }
        img.onerror = () => resolve(null)
        img.src = url
      })
      resolvedTextures.set(relPath, tex)
      return tex
    } catch {
      resolvedTextures.set(relPath, null)
      return null
    }
  })()

  textureCache.set(relPath, promise)
  return promise
}

export function preloadCommonInappTextures(): void {
  const paths = [
    'player/loose/Sprite/bg_story_adv.png',
    'player/loose/Sprite/bg_base_half_r8_wh.png',
    'player/loose/Sprite/bg_base_round_h48_wh.png',
    'player/loose/Sprite/icon_triangle_h22_wh.png',
    'player/loose/Sprite/btn_circle_h80_wh.png',
    'player/loose/Sprite/icon_menu_story_wh.png',
    'player/loose/Sprite/icon_pageForward_gn.png',
    'player/loose/Sprite/btn_round_h80_wh.png',
    'player/loose/Sprite/eff_btn_round_h80_a70_wh.png',
    'player/loose/Texture2D/tex_transition_left.png',
    'player/loose/Texture2D/tex_transition_top.png',
    'player/loose/Texture2D/tex_common_tri_01.png',
    'player/loose/Texture2D/holo.png'
  ]
  for (const rel of paths) {
    void loadInappTexture(rel)
  }
}
