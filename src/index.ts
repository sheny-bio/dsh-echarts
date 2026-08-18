/** Host half: serve the local ECharts UMD bundle and effective client config. */

import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import {
  CONFIG_ROUTE,
  DIST_PREFIX,
  ECHARTS_BUNDLE,
  ECHARTS_DIST_FILE,
  validateConfig,
  type EChartsPluginConfig,
} from './protocol.ts'

export { DEFAULT_CONFIG, validateConfig } from './protocol.ts'
export type { EChartsPluginConfig, EChartsTheme } from './protocol.ts'

const require = createRequire(import.meta.url)

export const name = 'echarts'
export const inject = ['webServer']

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export interface EChartsHostContext {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
  effect(callback: () => (() => void), label?: string): void
}

interface CachedAsset {
  body: Buffer
  etag: string
  mtimeMs: number
  size: number
}

/** The bundle is ~1MB of unchanging dependency output; re-reading it per request is pure waste. */
const assetCache = new Map<string, CachedAsset>()

async function readAsset(target: string): Promise<CachedAsset> {
  const info = await stat(target)
  const cached = assetCache.get(target)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
  const asset: CachedAsset = {
    body: await readFile(target),
    etag: `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
    mtimeMs: info.mtimeMs,
    size: info.size,
  }
  assetCache.set(target, asset)
  return asset
}

/** Serve only the ECharts UMD bundle and its source map from a dependency root. */
export async function serveDistFile(
  distRoot: string,
  pathname: string,
  res: ServerResponse,
  ifNoneMatch?: string,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (pathname !== `/${ECHARTS_BUNDLE}` && pathname !== `/${ECHARTS_BUNDLE}.map`) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const asset = await readAsset(target)
    // 'no-cache' means revalidate, not "don't store" — the ETag turns that into an empty 304.
    if (ifNoneMatch === asset.etag) {
      res.writeHead(304, { etag: asset.etag, 'cache-control': 'no-cache' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag: asset.etag,
    })
    res.end(asset.body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

function resolveEChartsDist(): string {
  return dirname(require.resolve(ECHARTS_DIST_FILE))
}

/** Register routes separately from dependency resolution so Host behavior is testable. */
export function registerRoutes(
  ctx: EChartsHostContext,
  config: EChartsPluginConfig,
  distRoot: string,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DIST_PREFIX,
    handler: (req, res) => {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.local').pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const relative = pathname.startsWith(DIST_PREFIX) ? pathname.slice(DIST_PREFIX.length) : pathname
      return serveDistFile(distRoot, relative, res, req.headers['if-none-match'])
    },
  }), 'dsh-echarts: dist route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(JSON.stringify(config))
    },
  }), 'dsh-echarts: config route')
}

export function apply(ctx: EChartsHostContext, rawConfig: Record<string, unknown> | undefined): void {
  registerRoutes(ctx, validateConfig(rawConfig), resolveEChartsDist())
}
