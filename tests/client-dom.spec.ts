// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupDetached,
  DARK_THEME_ATTR,
  dispose,
  ERROR_BAR_CLASS,
  fenceSource,
  HOST_CLASS,
  isEChartsBlock,
  refreshThemes,
  RENDERED_ATTR,
  resolveTheme,
  scan,
  type EChartsApi,
  type EChartsInstance,
  type EChartsRenderEnv,
} from '../src/client/dom.ts'
import { mountStyles, STYLE_ID } from '../src/client/styles.ts'
import { DEFAULT_CONFIG } from '../src/protocol.ts'
import { codeBlock as buildCodeBlock } from './fixtures.ts'

function codeBlock(language: string, source: string): HTMLElement {
  return buildCodeBlock(document, language, source)
}

interface MockHarness {
  env: EChartsRenderEnv
  api: EChartsApi
  charts: EChartsInstance[]
  init: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

function harness(setOptionError?: Error): MockHarness {
  const charts: EChartsInstance[] = []
  const init = vi.fn((host: HTMLElement) => {
    host.append(document.createElement('canvas'))
    const chart: EChartsInstance = {
      setOption: vi.fn(() => { if (setOptionError !== undefined) throw setOptionError }),
      resize: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false),
    }
    charts.push(chart)
    return chart
  })
  const api: EChartsApi = { init }
  const resolved = Promise.resolve(api)
  const load = vi.fn(() => resolved)
  return { env: { loadECharts: load, config: DEFAULT_CONFIG }, api, charts, init, load }
}

async function settle(): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, 20))
}

beforeEach(() => {
  dispose()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.body.removeAttribute(DARK_THEME_ATTR)
  Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'ResizeObserver', { value: undefined, configurable: true, writable: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  dispose()
  vi.restoreAllMocks()
})

describe('fence detection', () => {
  it('matches exact lowercase echarts only and trims one display newline', () => {
    const exact = codeBlock('echarts', '{"series":[]}')
    expect(isEChartsBlock(exact)).toBe(true)
    expect(fenceSource(exact)).toBe('{"series":[]}')
    expect(isEChartsBlock(codeBlock('ECharts', '{}'))).toBe(false)
    expect(isEChartsBlock(codeBlock('', '{}'))).toBe(false)
  })

  it('resolves auto, light, and dark themes', () => {
    expect(resolveTheme(DEFAULT_CONFIG, false)).toBeNull()
    expect(resolveTheme(DEFAULT_CONFIG, true)).toBe('dark')
    expect(resolveTheme({ ...DEFAULT_CONFIG, theme: 'light' }, true)).toBeNull()
    expect(resolveTheme({ ...DEFAULT_CONFIG, theme: 'dark' }, false)).toBe('dark')
  })
})

describe('render lifecycle', () => {
  it('replaces only the pre, preserves the banner, and normalizes tooltip security', async () => {
    const block = codeBlock('echarts', '{"tooltip":{"renderMode":"html"},"series":[{"type":"bar","data":[1,2]}]}')
    document.body.append(block)
    const mock = harness()
    scan(mock.env)
    await settle()

    expect(block.querySelector('pre')).toBeNull()
    expect(block.querySelector(`.${HOST_CLASS} canvas`)).not.toBeNull()
    expect(block.querySelector('[class*="infostring"]')?.textContent).toBe('echarts')
    expect(block.querySelector('button')?.textContent).toBe('复制')
    expect(mock.init).toHaveBeenCalledWith(expect.any(HTMLElement), null, { renderer: 'canvas' })
    expect(mock.charts[0]!.setOption).toHaveBeenCalledWith(expect.objectContaining({
      tooltip: { renderMode: 'richText' },
    }), { notMerge: true, lazyUpdate: false })
    expect(block.getAttribute(RENDERED_ATTR)).toBe('1')
  })

  it('is idempotent across repeated scans', async () => {
    document.body.append(codeBlock('echarts', '{"series":[]}'))
    const mock = harness()
    scan(mock.env)
    scan(mock.env)
    await settle()
    scan(mock.env)
    expect(mock.init).toHaveBeenCalledOnce()
  })

  it('keeps source and shows a text-only error for invalid JSON or render failure', async () => {
    const invalid = codeBlock('echarts', '{bad json}')
    document.body.append(invalid)
    const mock = harness()
    scan(mock.env)
    expect(invalid.querySelector('pre')).not.toBeNull()
    expect(invalid.querySelector(`.${ERROR_BAR_CLASS}`)?.textContent).toContain('invalid JSON')
    expect(invalid.querySelector(`.${ERROR_BAR_CLASS} script`)).toBeNull()
    expect(mock.load).not.toHaveBeenCalled()

    const failed = codeBlock('echarts', '{"series":[]}')
    document.body.append(failed)
    const renderFailure = harness(new Error('<script>alert(1)</script>'))
    scan(renderFailure.env)
    await settle()
    expect(failed.querySelector('pre')).not.toBeNull()
    expect(failed.querySelector(`.${ERROR_BAR_CLASS}`)?.textContent).toContain('<script>alert(1)</script>')
    expect(failed.querySelector('script')).toBeNull()
  })

  it('restores source when the ECharts bundle cannot load', async () => {
    const block = codeBlock('echarts', '{"series":[]}')
    document.body.append(block)
    const env: EChartsRenderEnv = {
      config: DEFAULT_CONFIG,
      loadECharts: vi.fn(() => Promise.reject(new Error('network unavailable'))),
    }
    scan(env)
    await settle()
    expect(block.querySelector('pre')).not.toBeNull()
    expect(block.querySelector(`.${ERROR_BAR_CLASS}`)?.textContent).toContain('network unavailable')
  })

  it('reinitializes visible charts when auto theme changes', async () => {
    document.body.append(codeBlock('echarts', '{"series":[]}'))
    const mock = harness()
    scan(mock.env)
    await settle()
    document.body.setAttribute(DARK_THEME_ATTR, '')
    refreshThemes(mock.env)
    await settle()

    expect(mock.init).toHaveBeenCalledTimes(2)
    expect(mock.init.mock.calls[1]?.[1]).toBe('dark')
    expect(mock.charts[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('resizes charts and disposes instances when blocks detach', async () => {
    let resizeCallback: ResizeObserverCallback | undefined
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
      observe(): void {}
      unobserve(): void {}
      disconnect = vi.fn()
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: FakeResizeObserver,
      configurable: true,
      writable: true,
    })
    const block = codeBlock('echarts', '{"series":[]}')
    document.body.append(block)
    const mock = harness()
    scan(mock.env)
    await settle()
    resizeCallback?.([], {} as ResizeObserver)
    expect(mock.charts[0]!.resize).toHaveBeenCalledOnce()

    block.remove()
    cleanupDetached()
    expect(mock.charts[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('restores the original pre when the plugin unloads', async () => {
    const block = codeBlock('echarts', '{"series":[]}')
    document.body.append(block)
    const mock = harness()
    scan(mock.env)
    await settle()
    expect(block.querySelector('pre')).toBeNull()
    dispose()
    expect(block.querySelector('pre')?.textContent).toContain('"series"')
    expect(block.querySelector(`.${HOST_CLASS}`)).toBeNull()
  })
})

describe('lazy viewport rendering', () => {
  it('does not load ECharts until a block intersects the 300px margin', async () => {
    let callback: IntersectionObserverCallback | undefined
    const observed: Element[] = []
    class FakeIntersectionObserver {
      constructor(cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { callback = cb }
      observe(target: Element): void { observed.push(target) }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return [] }
      readonly root = null
      readonly rootMargin = '300px'
      readonly thresholds = [0]
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: FakeIntersectionObserver,
      configurable: true,
      writable: true,
    })
    const block = codeBlock('echarts', '{"series":[]}')
    document.body.append(block)
    const mock = harness()
    scan(mock.env)
    await settle()
    expect(observed).toEqual([block])
    expect(mock.load).not.toHaveBeenCalled()

    callback?.([{ target: block, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await settle()
    expect(mock.load).toHaveBeenCalledOnce()
    expect(block.querySelector(`.${HOST_CLASS} canvas`)).not.toBeNull()
  })
})

describe('styles', () => {
  it('reference-counts one shared stylesheet', () => {
    const first = mountStyles()
    const second = mountStyles()
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
    expect(document.getElementById(STYLE_ID)?.textContent).toContain('.dsh-echarts-loading')
    first()
    expect(document.getElementById(STYLE_ID)).not.toBeNull()
    second()
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })
})
