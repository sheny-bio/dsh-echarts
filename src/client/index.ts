/** Client half: observe settled DSH code fences and render ECharts lazily. */

import {
  CONFIG_ROUTE,
  DEFAULT_CONFIG,
  DIST_PREFIX,
  ECHARTS_BUNDLE,
  validateConfig,
  type EChartsPluginConfig,
} from '../protocol.ts'
import { dispose, refreshThemes, scan, type EChartsApi, type EChartsRenderEnv } from './dom.ts'
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
  const pending = new Promise<EChartsApi>((resolve, reject) => {
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
    }, 15_000)
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
  })
  const cached = pending.catch((error) => {
    echartsPromise = undefined
    throw error
  })
  echartsPromise = cached
  return cached
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

export function apply(ctx: ClientContext): void {
  ctx.effect(() => mountStyles(), 'dsh-echarts: styles')

  ctx.effect(() => {
    let active = true
    let fenceObserver: MutationObserver | undefined
    let themeObserver: MutationObserver | undefined

    void loadConfig().then((config) => {
      if (!active) return
      const env: EChartsRenderEnv = { loadECharts, config }
      scan(env)

      fenceObserver = new MutationObserver(() => scan(env))
      fenceObserver.observe(document.body, { childList: true, subtree: true })

      themeObserver = new MutationObserver(() => refreshThemes(env))
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
    })

    return () => {
      active = false
      fenceObserver?.disconnect()
      themeObserver?.disconnect()
      dispose()
    }
  }, 'dsh-echarts: fence and theme observers')
}
