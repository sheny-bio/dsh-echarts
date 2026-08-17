# dsh-echarts

[English](./README.en.md)

在 DSH Web 会话中，把已完成的 ````echarts` 代码围栏自动渲染为交互式 Apache ECharts Canvas 图表。插件直接增强 Web UI，不要求模型调用 Tool。

## 工作方式

- Host 注册 `/echarts-dist`，从插件自己的 `echarts` dependency 提供 UMD bundle 和有效配置，不使用 CDN。
- Client 监听 `.md-code-block`，只处理 infostring 严格等于 `echarts` 的已定格围栏。
- 图表进入视口前 300px 时才 lazy load；多图串行初始化，保留 DSH 的语言横幅和复制按钮。
- 图表跟随 `body[data-ds-dark-theme]` 切换 light/dark theme，并通过 `ResizeObserver` 响应容器尺寸变化。
- JSON、资源加载或渲染失败时保留源码，显示可复制的纯文本错误。

## 输入格式

围栏内容必须是 Strict JSON，并且根节点是一个 ECharts option object：

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

JSON5、JavaScript function 和 expression 不受支持，因此 `formatter` function、`renderItem` 与 event callback 无法使用。字符串 formatter 可以使用。

## 安装

从 GitHub 安装并重启 DSH Web：

```bash
dsh plugin --profile web add github:sheny-bio/dsh-echarts
dsh web
```

若 pnpm 阻止 Git dependency 执行 `prepare`，按错误提示将 `@dsh-external/dsh-echarts` 加入 Web profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重试。

本地开发安装：

```bash
npm install
npm run check
npm test
npm run build
dsh plugin --profile web add .
dsh web
```

卸载：

```bash
dsh plugin --profile web remove @dsh-external/dsh-echarts
```

## 配置

默认 patch：

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

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `theme` | `auto` | `auto`、`light` 或 `dark`；`auto` 跟随 DSH Web |
| `height` | `400` | 图表高度，允许 200–1200 CSS pixels |
| `maxTextSize` | `200000` | 单个围栏的 UTF-8 bytes 上限 |
| `maxOptionNodes` | `100000` | 单个 option 递归访问的 JSON value 数量上限 |

Canvas renderer 为首版固定行为。

## 安全模型

AI 输出按不可信输入处理：

- 仅执行 `JSON.parse()`，不调用 `eval()`、`new Function()`，也不绑定模型提供的 event handler。
- 拒绝 prototype-pollution key、超过 64 层的 option、外部/data image、`image://` symbol、title navigation 和可见的 `toolbox.dataView`。
- tooltip 被强制设置为 `renderMode: richText`，避免把模型内容放进 HTML tooltip。
- 错误内容只通过 `textContent` 展示；失败后恢复原 `<pre>`。
- ECharts bundle 从本地 dependency 提供，不从 CDN 或模型指定 URL 加载。

## 测试

```bash
npm run check
npm test
```

连接已经安装插件的本地 DSH Web 后，可运行 Playwright E2E：

```bash
npx playwright install chromium
DSH_WEB_BASE=http://127.0.0.1:3080 npm run test:e2e
```

默认 `npm test` 不启动浏览器或要求 DSH 服务。

## 已知限制

- 依赖 DSH CodeBlock 的 `.md-code-block` 和 infostring class segment；上游 DOM 调整后需同步更新 selector。
- 流式阶段不渲染，只有 DSH 生成带 `echarts` infostring 的 settled block 后才渲染。
- Strict JSON 无法表达 ECharts custom series、function formatter 或其他 JavaScript callback。
- `theme: auto` 只能改变 ECharts 默认 theme；option 中硬编码的颜色不会自动转换。

## Acknowledgements

Host/Client 结构与 DOM lifecycle 参考了 MIT licensed [dsh-mermaid](https://github.com/AKS1st/dsh-mermaid)。详见 [NOTICE](./NOTICE)。
