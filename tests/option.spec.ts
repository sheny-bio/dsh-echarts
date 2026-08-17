import { describe, expect, it } from 'vitest'
import { parseEChartsOption } from '../src/option.ts'
import { DEFAULT_CONFIG, type EChartsPluginConfig } from '../src/protocol.ts'

function config(overrides: Partial<EChartsPluginConfig> = {}): EChartsPluginConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

describe('parseEChartsOption', () => {
  it('parses a normal option and forces every tooltip to richText', () => {
    const option = parseEChartsOption(JSON.stringify({
      tooltip: { renderMode: 'html' },
      series: [{ type: 'bar', data: [1, 2], tooltip: {} }],
      media: [{ option: { tooltip: [{ show: true }] } }],
    }), config())

    expect(option['tooltip']).toMatchObject({ renderMode: 'richText' })
    expect(option).toMatchObject({
      series: [{ tooltip: { renderMode: 'richText' } }],
      media: [{ option: { tooltip: [{ renderMode: 'richText' }] } }],
    })
  })

  it.each(['null', '[]', '1', '"text"', 'true'])('rejects a non-object root: %s', (source) => {
    expect(() => parseEChartsOption(source, config())).toThrow('root must be a JSON object')
  })

  it('accepts Strict JSON only', () => {
    expect(() => parseEChartsOption("{'series': []}", config())).toThrow('invalid JSON')
    expect(() => parseEChartsOption('{"formatter": () => "x"}', config())).toThrow('invalid JSON')
  })

  it('rejects a JSON exponent that overflows to Infinity', () => {
    expect(() => parseEChartsOption('{"series":[{"data":[1e999]}]}', config())).toThrow('non-finite number')
  })

  it.each(['__proto__', 'prototype', 'constructor'])('rejects the unsafe key %s', (key) => {
    expect(() => parseEChartsOption(`{"series": [{"${key}": {}}]}`, config())).toThrow(`unsafe key "${key}"`)
  })

  it('enforces UTF-8 byte size and total node limits', () => {
    expect(() => parseEChartsOption('{"标题":"图表"}', config({ maxTextSize: 5 }))).toThrow('maxTextSize')
    expect(() => parseEChartsOption('{"a":[1,2]}', config({ maxOptionNodes: 3 }))).toThrow('maxOptionNodes')
  })

  it('enforces a maximum nesting depth', () => {
    let value: Record<string, unknown> = {}
    for (let index = 0; index < 65; index += 1) value = { nested: value }
    expect(() => parseEChartsOption(JSON.stringify(value), config())).toThrow('maximum depth 64')
  })

  it.each([
    ['{"series":[{"symbol":"image://https://example.com/a.png"}]}', 'external image symbol'],
    ['{"graphic":{"style":{"image":"https://example.com/a.png"}}}', 'external image'],
    ['{"backgroundColor":{"image":"data:image/svg+xml;base64,AA=="}}', 'external image'],
    ['{"title":{"link":"https://example.com"}}', 'title navigation'],
    ['{"baseOption":{"title":{"sublink":"javascript:alert(1)"}}}', 'title navigation'],
    ['{"toolbox":{"feature":{"dataView":{"show":true,"lang":["<img src=x onerror=alert(1)>"]}}}}', 'toolbox dataView'],
  ])('rejects unsafe resource or navigation option', (source, message) => {
    expect(() => parseEChartsOption(source, config())).toThrow(message)
  })

  it('does not reject a URL used as ordinary chart data', () => {
    expect(parseEChartsOption('{"series":[{"data":["https://example.com"]}]}', config())).toMatchObject({
      series: [{ data: ['https://example.com'] }],
    })
  })

  it('allows an explicitly disabled toolbox dataView', () => {
    expect(parseEChartsOption('{"toolbox":{"feature":{"dataView":{"show":false}}}}', config())).toMatchObject({
      toolbox: { feature: { dataView: { show: false } } },
    })
  })
})
