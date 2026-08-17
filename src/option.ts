import type { EChartsPluginConfig } from './protocol.ts'

export type EChartsOption = Record<string, unknown>

const MAX_DEPTH = 64
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const EXTERNAL_IMAGE = /^(?:image:\/\/|https?:\/\/|\/\/|data:|blob:|javascript:)/i
const TITLE_LINK_KEYS = new Set(['link', 'target', 'sublink', 'subtarget'])

export class EChartsOptionError extends Error {
  constructor(message: string) {
    super(`dsh-echarts: ${message}`)
    this.name = 'EChartsOptionError'
  }
}

function pathLabel(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '<root>'
  return path.map((part, index) => typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`).join('')
}

function validateTree(value: unknown, config: EChartsPluginConfig): void {
  let nodes = 0

  const visit = (current: unknown, path: Array<string | number>, depth: number): void => {
    if (depth > MAX_DEPTH) throw new EChartsOptionError(`option exceeds maximum depth ${MAX_DEPTH} at ${pathLabel(path)}`)
    nodes += 1
    if (nodes > config.maxOptionNodes) {
      throw new EChartsOptionError(`option exceeds maxOptionNodes (${config.maxOptionNodes})`)
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new EChartsOptionError(`non-finite number is not allowed at ${pathLabel(path)}`)
    }
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, index], depth + 1))
      return
    }

    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new EChartsOptionError(`unsafe key "${key}" at ${pathLabel([...path, key])}`)
      }
      if (key === 'symbol' && typeof child === 'string' && /^image:\/\//i.test(child)) {
        throw new EChartsOptionError(`external image symbol is not allowed at ${pathLabel([...path, key])}`)
      }
      if (key === 'image' && typeof child === 'string' && EXTERNAL_IMAGE.test(child.trim())) {
        throw new EChartsOptionError(`external image is not allowed at ${pathLabel([...path, key])}`)
      }
      if (path.includes('title') && TITLE_LINK_KEYS.has(key) && typeof child === 'string' && child.trim() !== '') {
        throw new EChartsOptionError(`title navigation is not allowed at ${pathLabel([...path, key])}`)
      }
      if (key === 'dataView' && path.includes('toolbox') && path.includes('feature')
        && child !== null && typeof child === 'object' && !Array.isArray(child)
        && (child as Record<string, unknown>)['show'] !== false) {
        throw new EChartsOptionError(`toolbox dataView is not allowed at ${pathLabel([...path, key])}`)
      }
      visit(child, [...path, key], depth + 1)
    }
  }

  visit(value, [], 0)
}

function forceRichTextTooltips(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) forceRichTextTooltips(item)
    return
  }
  const object = value as Record<string, unknown>
  for (const [key, child] of Object.entries(object)) {
    if (key === 'tooltip') {
      const tooltips = Array.isArray(child) ? child : [child]
      for (const tooltip of tooltips) {
        if (tooltip !== null && typeof tooltip === 'object' && !Array.isArray(tooltip)) {
          ;(tooltip as Record<string, unknown>)['renderMode'] = 'richText'
        }
      }
    }
    forceRichTextTooltips(child)
  }
}

/** Parse, resource-bound, and sanitize an untrusted assistant-produced option. */
export function parseEChartsOption(source: string, config: EChartsPluginConfig): EChartsOption {
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > config.maxTextSize) {
    throw new EChartsOptionError(`fence is ${bytes} bytes; maxTextSize is ${config.maxTextSize}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new EChartsOptionError(`invalid JSON: ${detail}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EChartsOptionError('the fence root must be a JSON object')
  }

  validateTree(parsed, config)
  forceRichTextTooltips(parsed)
  return parsed as EChartsOption
}
