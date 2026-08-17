import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRoutes, serveDistFile, type EChartsHostContext } from '../src/index.ts'
import { CONFIG_ROUTE, DEFAULT_CONFIG, DIST_PREFIX } from '../src/protocol.ts'

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
  await writeFile(join(root, 'echarts.min.js'), 'window.echarts = {}')
  await writeFile(join(root, 'echarts.min.js.map'), '{}')
  return root
}

function response(): [CapturedResponse, ServerResponse] {
  const capture = new CapturedResponse()
  return [capture, capture as unknown as ServerResponse]
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('serveDistFile', () => {
  it('serves only the bundle and source map with explicit MIME types', async () => {
    const root = await fixtureRoot()
    const [js, jsResponse] = response()
    await serveDistFile(root, '/echarts.min.js', jsResponse)
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.body.toString()).toContain('window.echarts')

    const [map, mapResponse] = response()
    await serveDistFile(root, '/echarts.min.js.map', mapResponse)
    expect(map.status).toBe(200)
    expect(map.headers['content-type']).toContain('application/json')
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

  it('returns 400 for malformed percent encoding', async () => {
    const root = await fixtureRoot()
    let prefixRoute: Parameters<EChartsHostContext['webServer']['register']>[0] | undefined
    const ctx: EChartsHostContext = {
      webServer: { register(route) { if (route.kind === 'prefix') prefixRoute = route; return () => {} } },
      effect(callback) { callback() },
    }
    registerRoutes(ctx, DEFAULT_CONFIG, root)
    const [capture, malformedResponse] = response()
    await prefixRoute!.handler({ url: `${DIST_PREFIX}/%E0%A4%A` } as IncomingMessage, malformedResponse)
    expect(capture.status).toBe(400)
  })
})
