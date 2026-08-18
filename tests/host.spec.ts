import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRoutes, serveDistFile, type EChartsHostContext } from '../src/index.ts'
import { CONFIG_ROUTE, DEFAULT_CONFIG, DIST_PREFIX, ECHARTS_BUNDLE } from '../src/protocol.ts'

class CapturedResponse {
  status = 0
  headers: Record<string, string> = {}
  body = Buffer.alloc(0)

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = headers
    return this
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    return this
  }
}

const tempRoots: string[] = []

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-echarts-host-'))
  tempRoots.push(root)
  await writeFile(join(root, ECHARTS_BUNDLE), 'window.echarts = {}')
  await writeFile(join(root, `${ECHARTS_BUNDLE}.map`), '{}')
  return root
}

function response(): [CapturedResponse, ServerResponse] {
  const capture = new CapturedResponse()
  return [capture, capture as unknown as ServerResponse]
}

/** Register against a throwaway root and hand back just the dist (prefix) route. */
async function prefixRoute(): Promise<Parameters<EChartsHostContext['webServer']['register']>[0]> {
  const root = await fixtureRoot()
  let route: Parameters<EChartsHostContext['webServer']['register']>[0] | undefined
  const ctx: EChartsHostContext = {
    webServer: { register(candidate) { if (candidate.kind === 'prefix') route = candidate; return () => {} } },
    effect(callback) { callback() },
  }
  registerRoutes(ctx, DEFAULT_CONFIG, root)
  return route!
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('serveDistFile', () => {
  it('serves only the bundle and source map with explicit MIME types', async () => {
    const root = await fixtureRoot()
    const [js, jsResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, jsResponse)
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.body.toString()).toContain('window.echarts')

    const [map, mapResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}.map`, mapResponse)
    expect(map.status).toBe(200)
    expect(map.headers['content-type']).toContain('application/json')
  })

  it('answers a matching If-None-Match with an empty 304', async () => {
    const root = await fixtureRoot()
    const [first, firstResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, firstResponse)
    const etag = first.headers['etag']
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)

    const [revalidated, revalidatedResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, revalidatedResponse, etag)
    expect(revalidated.status).toBe(304)
    expect(revalidated.body).toHaveLength(0)

    const [stale, staleResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, staleResponse, '"outdated"')
    expect(stale.status).toBe(200)
    expect(stale.body.toString()).toContain('window.echarts')
  })

  it('re-reads the bundle after it changes on disk', async () => {
    const root = await fixtureRoot()
    const [first, firstResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, firstResponse)

    await writeFile(join(root, ECHARTS_BUNDLE), 'window.echarts = { version: "next" }')
    const [second, secondResponse] = response()
    await serveDistFile(root, `/${ECHARTS_BUNDLE}`, secondResponse, first.headers['etag'])
    expect(second.status).toBe(200)
    expect(second.body.toString()).toContain('next')
    expect(second.headers['etag']).not.toBe(first.headers['etag'])
  })

  it('rejects traversal and unknown files', async () => {
    const root = await fixtureRoot()
    const [traversal, traversalResponse] = response()
    await serveDistFile(root, '/../secret.js', traversalResponse)
    expect(traversal.status).toBe(403)

    const [unknown, unknownResponse] = response()
    await serveDistFile(root, '/index.html', unknownResponse)
    expect(unknown.status).toBe(404)
  })
})

describe('registerRoutes', () => {
  it('registers disposable dist and config routes', async () => {
    const root = await fixtureRoot()
    const routes: Array<Parameters<EChartsHostContext['webServer']['register']>[0]> = []
    const unregister = [vi.fn(), vi.fn()]
    const disposers: Array<() => void> = []
    const ctx: EChartsHostContext = {
      webServer: {
        register(route) {
          routes.push(route)
          return unregister[routes.length - 1]!
        },
      },
      effect(callback) { disposers.push(callback()) },
    }
    registerRoutes(ctx, DEFAULT_CONFIG, root)

    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['prefix', DIST_PREFIX],
      ['exact', CONFIG_ROUTE],
    ])
    const [capture, configResponse] = response()
    await routes[1]!.handler({ url: CONFIG_ROUTE } as IncomingMessage, configResponse)
    expect(capture.status).toBe(200)
    expect(JSON.parse(capture.body.toString())).toEqual(DEFAULT_CONFIG)

    for (const dispose of disposers) dispose()
    expect(unregister[0]).toHaveBeenCalledOnce()
    expect(unregister[1]).toHaveBeenCalledOnce()
  })

  it('forwards If-None-Match from the request to the asset handler', async () => {
    const route = await prefixRoute()
    const url = `${DIST_PREFIX}/${ECHARTS_BUNDLE}`

    const [first, firstResponse] = response()
    await route.handler({ url, headers: {} } as IncomingMessage, firstResponse)
    expect(first.status).toBe(200)

    const [cached, cachedResponse] = response()
    await route.handler(
      { url, headers: { 'if-none-match': first.headers['etag'] } } as unknown as IncomingMessage,
      cachedResponse,
    )
    expect(cached.status).toBe(304)
  })

  it('returns 400 for malformed percent encoding', async () => {
    const route = await prefixRoute()
    const [capture, malformedResponse] = response()
    await route.handler({ url: `${DIST_PREFIX}/%E0%A4%A` } as IncomingMessage, malformedResponse)
    expect(capture.status).toBe(400)
  })
})
