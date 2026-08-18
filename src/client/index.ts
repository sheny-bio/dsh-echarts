/** Client half: observe settled DSH code fences and render ECharts lazily. */

import {
  CONFIG_ROUTE,
  DEFAULT_CONFIG,
  DIST_PREFIX,
  ECHARTS_BUNDLE,
  LOAD_TIMEOUT_MS,
  validateConfig,
  type EChartsPluginConfig,
} from '../protocol.ts'
import { DARK_THEME_ATTR, dispose, refreshThemes, scan, type EChartsApi, type EChartsRenderEnv } from './dom.ts'
import { mountStyles } from './styles.ts'

declare global {
  interface Window {
    echarts?: EChartsApi
  }
}

interface ClientContext {
  effect(callback: () => (() => void), label?: string): void
}

let echartsPromise: Promise<EChartsApi> | undefined
let configPromise: Promise<EChartsPluginConfig> | undefined

function loadECharts(): Promise<EChartsApi> {
  if (echartsPromise !== undefined) return echartsPromise
  echartsPromise = new Promise<EChartsApi>((resolve, reject) => {
    if (window.echarts !== undefined) {
      resolve(window.echarts)
      return
    }
    const script = document.createElement('script')
    script.src = `${DIST_PREFIX}/${ECHARTS_BUNDLE}`
    script.async = true
    script.dataset['dshEchartsBundle'] = '1'
    const timeout = window.setTimeout(() => {
      script.remove()
      reject(new Error('dsh-echarts: timed out loading ECharts bundle'))
    }, LOAD_TIMEOUT_MS)
    script.onload = () => {
      window.clearTimeout(timeout)
      if (window.echarts === undefined) reject(new Error('dsh-echarts: bundle loaded but window.echarts is missing'))
      else resolve(window.echarts)
    }
    script.onerror = () => {
      window.clearTimeout(timeout)
      script.remove()
      reject(new Error('dsh-echarts: failed to load ECharts bundle'))
    }
    document.head.append(script)
  }).catch((error) => {
    echartsPromise = undefined // Let a later fence retry after a transient network failure.
    throw error
  })
  return echartsPromise
}

function loadConfig(): Promise<EChartsPluginConfig> {
  if (configPromise === undefined) {
    configPromise = fetch(CONFIG_ROUTE, { cache: 'no-store' })
      .then(response => response.ok
        ? response.json() as Promise<Record<string, unknown>>
        : Promise.reject(new Error(`dsh-echarts: config route returned ${response.status}`)))
      .then(raw => validateConfig(raw))
      .catch((error) => {
        console.warn('dsh-echarts: using default config', error)
        return DEFAULT_CONFIG
      })
  }
  return configPromise
}

/**
 * Coalesce bursts of DOM mutations into one scan per frame.
 *
 * Streaming a reply mutates the conversation subtree dozens of times per second, and each
 * scan is a full-document query — running one per mutation record burns the main thread on
 * repeated work that only the last pass can act on.
 */
interface FrameScheduler {
  schedule(): void
  cancel(): void
}

function frameScheduler(run: () => void): FrameScheduler {
  const canAnimate = typeof requestAnimationFrame === 'function'
  let handle: number | undefined
  const fire = (): void => {
    handle = undefined
    run()
  }
  return {
    schedule(): void {
      if (handle !== undefined) return
      handle = canAnimate ? requestAnimationFrame(fire) : window.setTimeout(fire, 16)
    },
    cancel(): void {
      if (handle === undefined) return
      if (canAnimate) cancelAnimationFrame(handle)
      else window.clearTimeout(handle)
      handle = undefined
    },
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => mountStyles(), 'dsh-echarts: styles')

  ctx.effect(() => {
    let active = true
    let fenceObserver: MutationObserver | undefined
    let themeObserver: MutationObserver | undefined
    let scheduler: FrameScheduler | undefined

    void loadConfig().then((config) => {
      if (!active) return
      const env: EChartsRenderEnv = { loadECharts, config }
      scan(env)

      scheduler = frameScheduler(() => { if (active) scan(env) })
      fenceObserver = new MutationObserver(() => scheduler?.schedule())
      fenceObserver.observe(document.body, { childList: true, subtree: true })

      // Theme changes are user-driven and rare, so they stay synchronous.
      themeObserver = new MutationObserver(() => refreshThemes(env))
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: [DARK_THEME_ATTR],
      })
    })

    return () => {
      active = false
      fenceObserver?.disconnect()
      themeObserver?.disconnect()
      scheduler?.cancel()
      dispose()
    }
  }, 'dsh-echarts: fence and theme observers')
}
