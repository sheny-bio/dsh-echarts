import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

const BASE = process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:3080'
const enabled = process.env.DSH_ECHARTS_E2E === '1'

describe.skipIf(!enabled)('live DSH Web with Playwright', () => {
  it('serves assets and turns settled fences into interactive canvases', async () => {
    const [config, bundle, umd] = await Promise.all([
      fetch(`${BASE}/echarts-dist/config.json`),
      fetch(`${BASE}/plugins/@dsh-external/dsh-echarts/client.js`),
      fetch(`${BASE}/echarts-dist/echarts.min.js`),
    ])
    expect(config.status).toBe(200)
    expect(bundle.status).toBe(200)
    expect(umd.status).toBe(200)

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(BASE)
      await page.evaluate(() => {
        const makeBlock = (suffix: string, language: string, option: unknown): HTMLElement => {
          const block = document.createElement('div')
          block.className = `_block_${suffix} md-code-block`
          const banner = document.createElement('div')
          const info = document.createElement('div')
          info.className = `_infostring_${suffix}`
          info.textContent = language
          const copy = document.createElement('button')
          copy.textContent = '复制'
          banner.append(info, copy)
          const pre = document.createElement('pre')
          const code = document.createElement('code')
          code.textContent = JSON.stringify(option)
          pre.append(code)
          block.append(banner, pre)
          return block
        }
        const interactiveOption = {
          tooltip: {},
          legend: {},
          dataZoom: [{ type: 'inside' }],
          xAxis: { type: 'category', data: ['A', 'B', 'C'] },
          yAxis: { type: 'value' },
          series: [{ name: 'value', type: 'bar', data: [1, 3, 2] }],
        }
        const streaming = makeBlock('e2e', '', interactiveOption)
        const second = makeBlock('e2e_second', 'echarts', {
          xAxis: {}, yAxis: {}, series: [{ type: 'line', data: [2, 1, 4] }],
        })
        const unsafe = makeBlock('e2e_unsafe', 'echarts', {
          title: { text: 'unsafe', link: 'https://example.com' }, series: [],
        })
        document.body.append(streaming, second, unsafe)
        const info = streaming.querySelector<HTMLElement>('[class*="infostring"]')!
        window.setTimeout(() => { info.textContent = 'echarts' }, 100)
      })
      const fixture = page.locator('.md-code-block._block_e2e')
      await fixture.locator('.dsh-echarts canvas').waitFor({ timeout: 10_000 })
      await page.locator('.md-code-block._block_e2e_second .dsh-echarts canvas').waitFor({ timeout: 10_000 })
      expect(await fixture.locator('[class*="infostring"]').textContent()).toBe('echarts')
      expect(await fixture.locator('button').textContent()).toBe('复制')
      expect(await fixture.getAttribute('data-dsh-echarts')).toBe('1')
      const unsafe = page.locator('.md-code-block._block_e2e_unsafe')
      await unsafe.locator('.dsh-echarts-error').waitFor({ timeout: 10_000 })
      expect(await unsafe.locator('pre').count()).toBe(1)

      await page.evaluate(() => document.body.toggleAttribute('data-ds-dark-theme'))
      await page.waitForTimeout(200)
      expect(await fixture.locator('.dsh-echarts canvas').count()).toBe(1)
      expect(await page.locator('.md-code-block._block_e2e_second .dsh-echarts canvas').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 30_000)
})
