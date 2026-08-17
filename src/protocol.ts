/** Shared Host/Client contract for routes and validated plugin configuration. */

export const DIST_PREFIX = '/echarts-dist'
export const CONFIG_ROUTE = `${DIST_PREFIX}/config.json`
export const ECHARTS_BUNDLE = 'echarts.min.js'
export const ECHARTS_DIST_FILE = 'echarts/dist/echarts.min.js'

export type EChartsTheme = 'auto' | 'light' | 'dark'

export interface EChartsPluginConfig {
  /** 'auto' follows body[data-ds-dark-theme]. */
  theme: EChartsTheme
  /** Chart height in CSS pixels. */
  height: number
  /** Maximum UTF-8 bytes accepted from one fence. */
  maxTextSize: number
  /** Maximum number of recursively visited values in one JSON option. */
  maxOptionNodes: number
}

export const DEFAULT_CONFIG: EChartsPluginConfig = {
  theme: 'auto',
  height: 400,
  maxTextSize: 200_000,
  maxOptionNodes: 100_000,
}

const THEMES = new Set<string>(['auto', 'light', 'dark'])
const CONFIG_KEYS = new Set<string>(['theme', 'height', 'maxTextSize', 'maxOptionNodes'])

function positiveInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-echarts: invalid ${key} "${String(value)}" (expected a positive integer)`)
  }
  return value
}

/** Validate the Cordis patch-row config and apply defaults. */
export function validateConfig(raw: Record<string, unknown> | undefined): EChartsPluginConfig {
  const input = raw ?? {}
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-echarts: unknown config key "${key}"`)
  }

  let theme: EChartsTheme
  if (input['theme'] === undefined) theme = DEFAULT_CONFIG.theme
  else if (typeof input['theme'] === 'string' && THEMES.has(input['theme'])) theme = input['theme'] as EChartsTheme
  else throw new Error(`dsh-echarts: invalid theme "${String(input['theme'])}" (expected auto, light, or dark)`)

  const height = input['height'] === undefined ? DEFAULT_CONFIG.height : positiveInteger(input['height'], 'height')
  if (height < 200 || height > 1200) {
    throw new Error(`dsh-echarts: invalid height "${height}" (expected an integer from 200 to 1200)`)
  }

  const maxTextSize = input['maxTextSize'] === undefined
    ? DEFAULT_CONFIG.maxTextSize
    : positiveInteger(input['maxTextSize'], 'maxTextSize')
  const maxOptionNodes = input['maxOptionNodes'] === undefined
    ? DEFAULT_CONFIG.maxOptionNodes
    : positiveInteger(input['maxOptionNodes'], 'maxOptionNodes')

  return { theme, height, maxTextSize, maxOptionNodes }
}
