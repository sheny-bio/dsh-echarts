// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { CODE_BLOCK_SELECTOR, HOST_CLASS } from '../src/client/dom.ts'
import { DEFAULT_CONFIG, DIST_PREFIX, ECHARTS_BUNDLE } from '../src/protocol.ts'
import { codeBlock } from './fixtures.ts'

const BUNDLE_PATH = resolve(import.meta.dirname, '../lib/client.js')
const BUNDLE_URL = `${DIST_PREFIX}/${ECHARTS_BUNDLE}`

type Apply = (ctx: { effect(callback: () => () => void): void }) => void

interface Harness {
  window: Window & typeof globalThis
  apply: Apply
  close(): void
}

/**
 * Load the real built bundle the way DSH Web does: through window.__ModuleLoader__.
 *
 * Both tests need the identical boot sequence, and it encodes the contract from
 * tsdown.config.mjs (loader id, banner shape) plus the config route — so it lives in one place.
 */
function bootBundle(): Harness {
  const bundle = readFileSync(BUNDLE_PATH, 'utf8')
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'http://localhost/',
  })
  const { window } = dom
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder })
  Object.defineProperty(window, 'fetch', {
    value: async () => new Response(JSON.stringify(DEFAULT_CONFIG), { status: 200 }),
  })

  let apply: Apply | undefined
  Object.defineProperty(window, '__ModuleLoader__', {
    value: {
      load({ id, factory }: { id: string; factory(require: unknown): Record<string, unknown> }) {
        expect(id).toBe('@dsh-external/dsh-echarts')
        apply = factory(() => { throw new Error('unexpected require') })['apply'] as Apply
      },
    },
  })
  const script = window.document.createElement('script')
  script.textContent = bundle
  window.document.head.append(script)
  expect(apply).toBeTypeOf('function')

  return {
    window: window as unknown as Window & typeof globalThis,
    apply: apply!,
    close: () => dom.window.close(),
  }
}

function settledFence(window: Window, source: string): HTMLElement {
  return codeBlock(window.document, 'echarts', source)
}

describe('built client bundle', () => {
  it('registers with ModuleLoader, lazy-loads one UMD, and renders multiple fences', async () => {
    expect(readFileSync(BUNDLE_PATH, 'utf8').length).toBeLessThan(100_000)
    expect(readFileSync(BUNDLE_PATH, 'utf8')).not.toContain('Licensed to the Apache Software Foundation')

    const { window, apply, close } = bootBundle()
    const setOption = vi.fn()
    const api = {
      init(host: HTMLElement) {
        host.append(window.document.createElement('canvas'))
        return { setOption, resize() {}, dispose() {}, isDisposed() { return false } }
      },
    }
    let umdLoads = 0
    const head = window.document.head
    const originalAppend = head.append.bind(head)
    Object.defineProperty(head, 'append', {
      configurable: true,
      value: (...nodes: Node[]) => {
        originalAppend(...nodes)
        for (const node of nodes) {
          const script = node as HTMLScriptElement
          if (script.tagName === 'SCRIPT' && script.src.endsWith(BUNDLE_URL)) {
            umdLoads += 1
            Object.defineProperty(window, 'echarts', { value: api, configurable: true })
            window.setTimeout(() => script.onload?.(new window.Event('load')), 0)
          }
        }
      },
    })

    window.document.body.append(
      settledFence(window, '{"series":[{"type":"bar","data":[1]}]}'),
      settledFence(window, '{"series":[{"type":"line","data":[2]}]}'),
    )

    const disposers: Array<() => void> = []
    apply({ effect(callback) { disposers.push(callback()) } })
    await new Promise(resolve => window.setTimeout(resolve, 80))

    expect(umdLoads).toBe(1)
    expect(window.document.querySelectorAll(`.${HOST_CLASS} canvas`)).toHaveLength(2)
    expect(setOption).toHaveBeenCalledTimes(2)
    for (const disposer of disposers.reverse()) disposer()
    close()
  })

  it('coalesces a burst of streaming mutations into a single document scan', async () => {
    const { window, apply, close } = bootBundle()
    Object.defineProperty(window, 'echarts', {
      configurable: true,
      value: {
        init(host: HTMLElement) {
          host.append(window.document.createElement('canvas'))
          return { setOption() {}, resize() {}, dispose() {}, isDisposed() { return false } }
        },
      },
    })

    // Count only the plugin's own full-document sweep for code blocks.
    let scans = 0
    const originalQueryAll = window.document.querySelectorAll.bind(window.document)
    Object.defineProperty(window.document, 'querySelectorAll', {
      configurable: true,
      value: (selector: string) => {
        if (selector === CODE_BLOCK_SELECTOR) scans += 1
        return originalQueryAll(selector)
      },
    })

    const disposers: Array<() => void> = []
    apply({ effect(callback) { disposers.push(callback()) } })
    await new Promise(resolve => window.setTimeout(resolve, 50))
    const afterStartup = scans

    // Streaming appends tokens across separate tasks, so each one is its own observer callback.
    // (Mutations inside a single synchronous block are already batched by MutationObserver itself,
    // and would pass this test even without coalescing.)
    const paragraph = window.document.createElement('p')
    window.document.body.append(paragraph)
    const TOKENS = 30
    for (let token = 0; token < TOKENS; token += 1) {
      paragraph.append(window.document.createElement('span'))
      await new Promise(resolve => window.setTimeout(resolve, 0))
    }
    window.document.body.append(settledFence(window, '{"series":[{"type":"bar","data":[1]}]}'))

    await new Promise(resolve => window.setTimeout(resolve, 100))
    const burstScans = scans - afterStartup
    expect(burstScans).toBeGreaterThan(0)
    expect(burstScans).toBeLessThan(TOKENS / 2)
    expect(window.document.querySelectorAll(`.${HOST_CLASS} canvas`)).toHaveLength(1)

    for (const disposer of disposers.reverse()) disposer()
    close()
  })
})
