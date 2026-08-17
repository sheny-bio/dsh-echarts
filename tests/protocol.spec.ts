import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, validateConfig } from '../src/protocol.ts'

describe('validateConfig', () => {
  it('uses production defaults', () => {
    expect(validateConfig(undefined)).toEqual(DEFAULT_CONFIG)
  })

  it('accepts every public setting', () => {
    expect(validateConfig({
      theme: 'dark',
      height: 720,
      maxTextSize: 300_000,
      maxOptionNodes: 120_000,
    })).toEqual({
      theme: 'dark',
      height: 720,
      maxTextSize: 300_000,
      maxOptionNodes: 120_000,
    })
  })

  it.each([
    [{ theme: 'default' }, 'invalid theme'],
    [{ height: 199 }, 'invalid height'],
    [{ height: 1201 }, 'invalid height'],
    [{ height: 400.5 }, 'positive integer'],
    [{ maxTextSize: 0 }, 'positive integer'],
    [{ maxOptionNodes: '100' }, 'positive integer'],
    [{ renderer: 'svg' }, 'unknown config key'],
  ])('rejects invalid config %j', (input, message) => {
    expect(() => validateConfig(input)).toThrow(message)
  })
})
