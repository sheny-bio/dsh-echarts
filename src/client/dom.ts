import { parseEChartsOption, type EChartsOption } from '../option.ts'
import { LOAD_TIMEOUT_MS, type EChartsPluginConfig } from '../protocol.ts'

export interface EChartsInstance {
  setOption(option: EChartsOption, settings?: Record<string, unknown>): void
  resize(): void
  dispose(): void
  isDisposed?(): boolean
}

export interface EChartsApi {
  init(
    container: HTMLElement,
    theme?: string | null,
    options?: { renderer: 'canvas' },
  ): EChartsInstance
}

export interface EChartsRenderEnv {
  loadECharts(): Promise<EChartsApi>
  config: EChartsPluginConfig
}

export const CODE_BLOCK_SELECTOR = '.md-code-block'
const INFOSTRING_SEGMENT = 'infostring'
export const RENDERED_ATTR = 'data-dsh-echarts'
const ERROR_ATTR = 'data-dsh-echarts-error'
export const HOST_CLASS = 'dsh-echarts'
const LOADING_CLASS = 'dsh-echarts-loading'
export const ERROR_BAR_CLASS = 'dsh-echarts-error'
/** DSH's dark-theme signal. Read here, subscribed to in ./index.ts, styled in ./styles.ts. */
export const DARK_THEME_ATTR = 'data-ds-dark-theme'

const OBSERVER_MARGIN = '300px'
const ERROR_SUMMARY_MAX = 180
const COPY_LABEL = '复制报错'
const COPIED_LABEL = '已复制'
const COPIED_RESET_MS = 1200

type RenderStatus = 'pending' | 'rendering' | 'rendered' | 'error'
type RenderKind = 'initial' | 'refresh'

interface ChartState {
  block: HTMLElement
  source: string
  option?: EChartsOption
  originalPre: HTMLElement
  status: RenderStatus
  visible: boolean
  theme?: string | null
  themeDirty: boolean
  host?: HTMLElement
  /** The loading stand-in, tracked here so restoring the source never depends on a CSS class. */
  placeholder?: HTMLElement
  chart?: EChartsInstance
  resizeObserver?: ResizeObserver
  /** Queue membership, so enqueue stays O(1) instead of scanning the whole queue. */
  queuedInitial: boolean
  queuedRefresh: boolean
}

interface QueuedRender {
  state: ChartState
  kind: RenderKind
}

const states = new Map<HTMLElement, ChartState>()
const renderQueue: QueuedRender[] = []
let lazyObserver: IntersectionObserver | undefined
let activeEnv: EChartsRenderEnv | undefined
let queueRunning = false
let lifecycleEpoch = 0

export function isEChartsBlock(block: HTMLElement): boolean {
  const info = block.querySelector<HTMLElement>(`[class*="${INFOSTRING_SEGMENT}"]`)
  return info?.textContent?.trim() === 'echarts'
}

export function fenceSource(block: HTMLElement): string {
  return block.querySelector('pre')?.textContent?.replace(/\n$/, '') ?? ''
}

export function resolveTheme(config: EChartsPluginConfig, dark: boolean): string | null {
  if (config.theme === 'dark') return 'dark'
  if (config.theme === 'light') return null
  return dark ? 'dark' : null
}

function currentTheme(config: EChartsPluginConfig): string | null {
  return resolveTheme(config, document.body.hasAttribute(DARK_THEME_ATTR))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

function buildErrorReport(source: string, error: unknown): string {
  return [
    'ECharts 渲染失败。',
    '',
    '错误信息：',
    errorMessage(error),
    '',
    '图表源码：',
    '```echarts',
    source,
    '```',
  ].join('\n')
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // Non-secure contexts and jsdom use the fallback below.
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try { document.execCommand('copy') } catch { /* best effort */ }
  textarea.remove()
}

function showErrorBar(state: ChartState, error: unknown): void {
  if (state.block.querySelector(`.${ERROR_BAR_CLASS}`) !== null) return
  const message = errorMessage(error)
  const summary = message.length > ERROR_SUMMARY_MAX ? `${message.slice(0, ERROR_SUMMARY_MAX)}…` : message
  const report = buildErrorReport(state.source, error)

  const bar = document.createElement('div')
  bar.className = ERROR_BAR_CLASS
  bar.setAttribute('role', 'alert')
  const text = document.createElement('div')
  text.className = `${ERROR_BAR_CLASS}-message`
  text.textContent = `渲染失败：${summary}`
  text.title = message
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = COPY_LABEL
  let resetTimer: number | undefined
  copy.addEventListener('click', () => {
    void copyText(report).then(() => {
      copy.textContent = COPIED_LABEL
      // Restart the timer rather than capturing the live label, which rapid clicks would read as "已复制".
      if (resetTimer !== undefined) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        resetTimer = undefined
        copy.textContent = COPY_LABEL
      }, COPIED_RESET_MS)
    })
  })
  bar.append(text, copy)
  state.block.append(bar)
}

function safeDisposeChart(chart: EChartsInstance | undefined): void {
  if (chart === undefined) return
  try {
    if (chart.isDisposed?.() !== true) chart.dispose()
  } catch {
    // Teardown must continue even if a third-party instance is already invalid.
  }
}

function restoreSource(state: ChartState): void {
  const replacement = state.host ?? state.placeholder
  if (replacement !== undefined && replacement.parentNode !== null) {
    replacement.replaceWith(state.originalPre)
  }
  state.host = undefined
  state.placeholder = undefined
}

/** Release everything a rendered block holds; both the error path and teardown need all of it. */
function releaseChart(state: ChartState): void {
  safeDisposeChart(state.chart)
  state.chart = undefined
  state.queuedInitial = false
  state.queuedRefresh = false
  state.resizeObserver?.disconnect()
  state.resizeObserver = undefined
  lazyObserver?.unobserve(state.block)
}

function failState(state: ChartState, error: unknown): void {
  releaseChart(state)
  restoreSource(state)
  state.status = 'error'
  state.themeDirty = false
  state.block.removeAttribute(RENDERED_ATTR)
  state.block.setAttribute(ERROR_ATTR, '1')
  showErrorBar(state, error)
  console.error('dsh-echarts: render failed', error)
}

function showLoading(state: ChartState, height: number): void {
  if (state.placeholder !== undefined || state.host !== undefined) return
  if (!state.block.contains(state.originalPre)) return
  const placeholder = document.createElement('div')
  placeholder.className = `${HOST_CLASS} ${LOADING_CLASS}`
  placeholder.style.height = `${height}px`
  placeholder.setAttribute('role', 'status')
  placeholder.setAttribute('aria-label', 'ECharts 渲染中')
  const spinner = document.createElement('span')
  spinner.className = `${LOADING_CLASS}-spinner`
  const label = document.createElement('span')
  label.textContent = '渲染中…'
  placeholder.append(spinner, label)
  state.originalPre.replaceWith(placeholder)
  state.placeholder = placeholder
}

function chartHost(height: number): HTMLElement {
  const host = document.createElement('div')
  host.className = HOST_CLASS
  host.style.height = `${height}px`
  host.setAttribute('role', 'img')
  host.setAttribute('aria-label', 'ECharts 图表')
  return host
}

function installResizeObserver(state: ChartState): void {
  if (state.resizeObserver !== undefined || typeof ResizeObserver === 'undefined' || state.host === undefined) return
  state.resizeObserver = new ResizeObserver(() => {
    const chart = state.chart
    if (state.status !== 'rendered' || chart === undefined || chart.isDisposed?.() === true) return
    try { chart.resize() } catch (error) { console.error('dsh-echarts: resize failed', error) }
  })
  state.resizeObserver.observe(state.host)
}

function isVisible(state: ChartState): boolean {
  return lazyObserver === undefined || state.visible
}

/** Still the live state for a block that is on-screen and in the document. */
function isRenderable(state: ChartState): boolean {
  return states.get(state.block) === state && document.contains(state.block) && isVisible(state)
}

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`dsh-echarts: bundle load timed out after ${timeout}ms`)), timeout)
    promise.then(
      value => { window.clearTimeout(timer); resolve(value) },
      error => { window.clearTimeout(timer); reject(error) },
    )
  })
}

/** Attach an instance to a host, never leaving a half-initialized chart behind on failure. */
function mountChart(state: ChartState, echarts: EChartsApi, host: HTMLElement, theme: string | null): void {
  const chart = echarts.init(host, theme, { renderer: 'canvas' })
  try {
    chart.setOption(state.option!, { notMerge: true, lazyUpdate: false })
  } catch (error) {
    safeDisposeChart(chart)
    throw error
  }
  state.chart = chart
  state.theme = theme
  state.themeDirty = false
}

async function renderInitial(state: ChartState, env: EChartsRenderEnv, epoch: number): Promise<void> {
  state.status = 'rendering'
  showLoading(state, env.config.height)
  try {
    const echarts = await withTimeout(env.loadECharts(), LOAD_TIMEOUT_MS)
    if (epoch !== lifecycleEpoch || states.get(state.block) !== state || !document.contains(state.block)) return
    if (!isVisible(state)) {
      restoreSource(state)
      state.status = 'pending'
      return
    }

    const host = chartHost(env.config.height)
    if (state.placeholder !== undefined) state.placeholder.replaceWith(host)
    else if (state.block.contains(state.originalPre)) state.originalPre.replaceWith(host)
    else throw new Error('dsh-echarts: code block body disappeared before render')
    state.placeholder = undefined
    state.host = host

    mountChart(state, echarts, host, currentTheme(env.config))
    state.status = 'rendered'
    state.block.setAttribute(RENDERED_ATTR, '1')
    installResizeObserver(state)
  } catch (error) {
    if (epoch === lifecycleEpoch && states.get(state.block) === state) failState(state, error)
  }
}

async function refreshTheme(state: ChartState, env: EChartsRenderEnv, epoch: number): Promise<void> {
  if (!state.themeDirty || !isVisible(state) || state.host === undefined) return
  try {
    const echarts = await withTimeout(env.loadECharts(), LOAD_TIMEOUT_MS)
    if (epoch !== lifecycleEpoch || states.get(state.block) !== state || !isVisible(state) || state.host === undefined) return
    const nextTheme = currentTheme(env.config)
    if (nextTheme === state.theme) {
      state.themeDirty = false
      return
    }
    safeDisposeChart(state.chart)
    state.chart = undefined
    mountChart(state, echarts, state.host, nextTheme)
  } catch (error) {
    if (epoch === lifecycleEpoch && states.get(state.block) === state) failState(state, error)
  }
}

function enqueue(state: ChartState, kind: RenderKind): void {
  // No status check for 'error' is needed: both branches below require a non-error status.
  if (kind === 'initial') {
    if (state.status !== 'pending' || state.queuedInitial) return
    state.queuedInitial = true
  } else {
    if (state.status !== 'rendered' || !state.themeDirty || state.queuedRefresh) return
    state.queuedRefresh = true
  }
  renderQueue.push({ state, kind })
  void drainQueue()
}

async function drainQueue(): Promise<void> {
  if (queueRunning) return
  queueRunning = true
  const epoch = lifecycleEpoch
  try {
    while (epoch === lifecycleEpoch && renderQueue.length > 0) {
      const item = renderQueue.shift()
      if (item === undefined) break
      if (item.kind === 'initial') item.state.queuedInitial = false
      else item.state.queuedRefresh = false
      // Drop dead items before yielding: nested setTimeout is clamped to ~4ms, so spending a
      // task on each one would delay the charts that do still need rendering.
      if (!isRenderable(item.state)) continue
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
      if (epoch !== lifecycleEpoch || activeEnv === undefined) break
      // Re-checked because the yield above gives teardown and scrolling a chance to invalidate it.
      if (!isRenderable(item.state)) continue
      if (item.kind === 'initial') await renderInitial(item.state, activeEnv, epoch)
      else await refreshTheme(item.state, activeEnv, epoch)
    }
  } finally {
    if (epoch === lifecycleEpoch) queueRunning = false
  }
}

function ensureObserver(): IntersectionObserver | undefined {
  if (lazyObserver !== undefined) return lazyObserver
  if (typeof IntersectionObserver === 'undefined') return undefined
  lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = states.get(entry.target as HTMLElement)
      if (state === undefined) continue
      state.visible = entry.isIntersecting
      if (!entry.isIntersecting) continue
      if (state.status === 'pending') enqueue(state, 'initial')
      else if (state.status === 'rendered' && state.themeDirty) enqueue(state, 'refresh')
    }
  }, { rootMargin: OBSERVER_MARGIN })
  return lazyObserver
}

function cleanupState(state: ChartState, restore: boolean): void {
  releaseChart(state)
  if (restore && document.contains(state.block)) restoreSource(state)
  state.block.querySelector(`.${ERROR_BAR_CLASS}`)?.remove()
  state.block.removeAttribute(RENDERED_ATTR)
  state.block.removeAttribute(ERROR_ATTR)
}

/** Dispose chart instances held by blocks removed from the conversation DOM. */
export function cleanupDetached(): void {
  for (const [block, state] of states) {
    if (document.contains(block)) continue
    cleanupState(state, false)
    states.delete(block)
  }
}

/** Register newly settled ```echarts fences for lazy rendering. */
export function scan(env: EChartsRenderEnv): void {
  activeEnv = env
  cleanupDetached()
  const observer = ensureObserver()
  for (const block of document.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR)) {
    // Cheap rejections first: isEChartsBlock walks the block's subtree with an attribute-substring
    // selector, and this loop re-runs every frame while a reply streams in.
    if (states.has(block) || block.hasAttribute(RENDERED_ATTR) || block.hasAttribute(ERROR_ATTR)) continue
    if (!isEChartsBlock(block)) continue
    const pre = block.querySelector<HTMLElement>('pre')
    if (pre === null) continue
    const source = fenceSource(block)
    if (source === '') continue
    const state: ChartState = {
      block,
      source,
      originalPre: pre,
      status: 'pending',
      visible: observer === undefined,
      themeDirty: false,
      queuedInitial: false,
      queuedRefresh: false,
    }
    states.set(block, state)
    try {
      state.option = parseEChartsOption(source, env.config)
    } catch (error) {
      failState(state, error)
      continue
    }
    if (observer === undefined) enqueue(state, 'initial')
    else observer.observe(block)
  }
}

/** Mark rendered charts stale after a DSH light/dark theme change. */
export function refreshThemes(env: EChartsRenderEnv): void {
  activeEnv = env
  for (const state of states.values()) {
    if (state.status !== 'rendered') continue
    state.themeDirty = state.theme !== currentTheme(env.config)
    if (state.themeDirty && isVisible(state)) enqueue(state, 'refresh')
  }
}

/** Full plugin teardown: observers, queue, chart instances, and restored source blocks. */
export function dispose(): void {
  lifecycleEpoch += 1
  lazyObserver?.disconnect()
  lazyObserver = undefined
  renderQueue.length = 0
  queueRunning = false
  activeEnv = undefined
  for (const state of states.values()) cleanupState(state, true)
  states.clear()
}
