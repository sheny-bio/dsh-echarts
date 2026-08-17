# dsh-echarts

[中文](./README.md)

Render settled ````echarts` fences in DSH Web conversations as interactive Apache ECharts Canvas charts. This is a Web UI enhancement; the model does not call a Tool.

## Input

The fence must contain a Strict JSON ECharts option object:

````markdown
```echarts
{
  "tooltip": {},
  "xAxis": { "type": "category", "data": ["A", "B", "C"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [12, 20, 15] }]
}
```
````

JSON5, JavaScript functions, expressions, `renderItem`, and event callbacks are intentionally unsupported.

## Install

```bash
dsh plugin --profile web add github:sheny-bio/dsh-echarts
dsh web
```

If pnpm blocks the Git dependency's `prepare` script, add `@dsh-external/dsh-echarts` to `allowBuilds` in the Web profile's `pnpm-workspace.yaml`, then retry.

For local development:

```bash
npm install
npm run check
npm test
npm run build
dsh plugin --profile web add .
dsh web
```

## Configuration

```yaml
- insert:
    - id: echarts
      name: '@dsh-external/dsh-echarts'
      config:
        theme: auto
        height: 400
        maxTextSize: 200000
        maxOptionNodes: 100000
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `theme` | `auto` | `auto`, `light`, or `dark`; auto follows DSH Web |
| `height` | `400` | Chart height, 200–1200 CSS pixels |
| `maxTextSize` | `200000` | UTF-8 byte limit for one fence |
| `maxOptionNodes` | `100000` | Recursive JSON value limit for one option |

Canvas is the fixed renderer in the first release.

## Behavior and security

- The ECharts UMD is served from the plugin dependency and loaded only when a visible chart needs it; no CDN is used.
- Charts initialize serially, resize with their container, follow the DSH light/dark theme, and dispose when their message leaves the DOM.
- Untrusted input is processed only with `JSON.parse()`; the plugin never calls `eval()` or `new Function()`.
- Prototype-pollution keys, excessive input, external/data images, `image://` symbols, title navigation, and visible `toolbox.dataView` features are rejected.
- Tooltips are forced to `renderMode: richText`. Errors are inserted with `textContent`, and the original source remains visible after failure.

## Tests

```bash
npm run check
npm test
```

Optional live DSH Playwright test:

```bash
npx playwright install chromium
DSH_WEB_BASE=http://127.0.0.1:3080 npm run test:e2e
```

The default test run does not require a browser or a running DSH server.

## Limitations

- The integration depends on DSH's `.md-code-block` class and readable infostring class segment.
- Streaming output renders only after DSH emits a settled block with the `echarts` infostring.
- Strict JSON cannot represent custom series, function formatters, or other JavaScript callbacks.
- Explicit colors in an option do not automatically adapt when the theme changes.

The Host/Client structure and DOM lifecycle were informed by the MIT-licensed [dsh-mermaid](https://github.com/AKS1st/dsh-mermaid). See [NOTICE](./NOTICE).
