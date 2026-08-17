// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

function settledFence(window: Window, source: string): HTMLElement {
  const block = window.document.createElement('div')
  block.className = '_block_hash md-code-block'
  const banner = window.document.createElement('div')
  const info = window.document.createElement('div')
  info.className = '_infostring_hash'
  info.textContent = 'echarts'
  const copy = window.document.createElement('button')
  copy.textContent = '复制'
  banner.append(info, copy)
  const pre = window.document.createElement('pre')
  const code = window.document.createElement('code')
  code.textContent = source
  pre.append(code)
  block.append(banner, pre)
  return block
}

describe('built client bundle', () => {
  it('registers with ModuleLoader, lazy-loads one UMD, and renders multiple fences', async () => {
    const bundle = readFileSync(resolve(import.meta.dirname, '../lib/client.js'), 'utf8')
    expect(bundle.length).toBeLessThan(100_000)
    expect(bundle).not.toContain('Licensed to the Apache Software Foundation')

    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    })
    const { window } = dom
    Object.defineProperty(window, 'TextEncoder', { value: TextEncoder })
    Object.defineProperty(window, 'fetch', {
      value: async () => new Response(JSON.stringify({
        theme: 'auto', height: 400, maxTextSize: 200_000, maxOptionNodes: 100_000,
      }), { status: 200 }),
    })

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
          if (script.tagName === 'SCRIPT' && script.src.endsWith('/echarts-dist/echarts.min.js')) {
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

    let apply: ((ctx: { effect(callback: () => () => void): void }) => void) | undefined
    Object.defineProperty(window, '__ModuleLoader__', {
      value: {
        load({ id, factory }: { id: string; factory(require: unknown): Record<string, unknown> }) {
          expect(id).toBe('@dsh-external/dsh-echarts')
          apply = factory(() => { throw new Error('unexpected require') })['apply'] as typeof apply
        },
      },
    })
    const script = window.document.createElement('script')
    script.textContent = bundle
    originalAppend(script)
    expect(apply).toBeTypeOf('function')

    const disposers: Array<() => void> = []
    apply!({ effect(callback) { disposers.push(callback()) } })
    await new Promise(resolve => window.setTimeout(resolve, 80))

    expect(umdLoads).toBe(1)
    expect(window.document.querySelectorAll('.dsh-echarts canvas')).toHaveLength(2)
    expect(setOption).toHaveBeenCalledTimes(2)
    for (const disposer of disposers.reverse()) disposer()
    dom.window.close()
  })
})
