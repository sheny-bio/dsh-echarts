/**
 * The one written description of DSH Web's settled code-block markup.
 *
 * src/client/dom.ts matches this shape via CODE_BLOCK_SELECTOR and INFOSTRING_SEGMENT, so when
 * DSH changes its markdown output this fixture is the single place the assumption is recorded.
 * tests/live-server-e2e.spec.ts keeps its own copy only because that one is serialized into the
 * page by Playwright and cannot import from here.
 */
export function codeBlock(doc: Document, language: string, source: string): HTMLElement {
  const block = doc.createElement('div')
  block.className = '_block_hash md-code-block'
  const banner = doc.createElement('div')
  const info = doc.createElement('div')
  info.className = '_infostring_hash'
  info.textContent = language
  const actions = doc.createElement('div')
  actions.className = '_action_hash'
  const copy = doc.createElement('button')
  copy.textContent = '复制'
  actions.append(copy)
  banner.append(info, actions)
  const pre = doc.createElement('pre')
  const code = doc.createElement('code')
  // DSH emits a trailing newline inside the fence; fenceSource is expected to strip exactly one.
  code.textContent = `${source}\n`
  pre.append(code)
  block.append(banner, pre)
  return block
}
