import { DARK_THEME_ATTR } from './dom.ts'

export const STYLE_ID = 'dsh-echarts-styles'

let mounts = 0

const CSS = `
.dsh-echarts {
  position: relative;
  width: 100%;
  overflow: hidden;
  background: var(--dsr-bg, transparent);
}
.dsh-echarts canvas {
  display: block;
}
.dsh-echarts-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: currentColor;
  opacity: .72;
}
.dsh-echarts-loading-spinner {
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: dsh-echarts-spin .8s linear infinite;
}
.dsh-echarts-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid color-mix(in srgb, #e5484d 45%, transparent);
  color: #c62a31;
  font-size: 12px;
}
body[${DARK_THEME_ATTR}] .dsh-echarts-error {
  color: #ff8b8f;
}
.dsh-echarts-error-message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-echarts-error button {
  flex: none;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
@keyframes dsh-echarts-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-echarts-loading-spinner { animation: none; }
}
`

/** Share one stylesheet across plugin lifetimes. */
export function mountStyles(): () => void {
  mounts += 1
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    mounts = Math.max(0, mounts - 1)
    if (mounts === 0) document.getElementById(STYLE_ID)?.remove()
  }
}
