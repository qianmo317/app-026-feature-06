import { describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { PastePreview } from '../../src/components/PastePreview'

function byId(root: HTMLElement, id: string) {
  const el = root.querySelector(`[data-testid="${id}"]`)
  if (!el) throw new Error(`missing testid: ${id}`)
  return el as HTMLElement
}
function allById(root: HTMLElement, id: string) {
  return [...root.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[]
}

/** React 受控组件必须走原生 setter 再派发 input 事件才能触发 onChange */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PastePreview smoke', () => {
  it('renders rows/issues, inline edits, commit payload', () => {
    const raw = '## 起段\n生：唱一句【过门五秒】\n超长角色名字呀：词【停顿0】\n\n旦：好的【锣鼓】'
    const committed: unknown[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        createElement(PastePreview, {
          raw,
          autoBlank: true,
          initialMode: 'append',
          existingSegmentCount: 2,
          existingLineCount: 5,
          lastSegmentTitle: '旧末段',
          onClose: () => {},
          onCommit: (mode: string, lines: unknown[], segments: unknown[]) =>
            committed.push({ mode, lines, segments }),
        }),
      )
    })

    expect(byId(container, 'preview-seg-count').textContent).toBe('2')
    expect(byId(container, 'preview-line-count').textContent).toBe('3')
    expect(byId(container, 'append-banner').textContent).toContain('旧末段')
    expect(byId(container, 'append-banner').textContent).toContain('接在')

    // 段标题：追加后编号含偏移
    expect(container.textContent).toContain('追加后第 3 段')

    // 切换替换模式 → 替换横幅
    act(() => {
      byId(container, 'preview-mode-replace').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(byId(container, 'replace-banner').textContent).toContain('替换')
    expect(byId(container, 'replace-banner').textContent).toContain('现有 2 段、5 句')

    // 三类问题各一条
    expect(allById(container, 'preview-issue-badSeconds').length).toBe(1)
    expect(allById(container, 'preview-issue-zeroSeconds').length).toBe(1)
    expect(allById(container, 'preview-issue-longRole').length).toBe(1)

    // 就地改角色（第 2 行）
    const roleInputs = allById(container, 'preview-line-role') as HTMLInputElement[]
    setValue(roleInputs[1], '旦')

    // 就地改秒数（「过门五秒」非数字 → 默认 4，改成 6）
    const secInputs = allById(container, 'preview-cue-seconds') as HTMLInputElement[]
    expect(Number(secInputs[0].value)).toBe(4)
    setValue(secInputs[0], '6')

    act(() => {
      byId(container, 'btn-preview-confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(committed.length).toBe(1)
    const payload = committed[0] as {
      mode: string
      lines: { role?: string; cues: { seconds?: number }[] }[]
      segments: { lineIds: string[] }[]
    }
    expect(payload.mode).toBe('replace')
    expect(payload.lines.length).toBe(3)
    expect(payload.segments.length).toBe(2)
    expect(payload.segments.map((s) => s.lineIds.length)).toEqual([2, 1])
    expect(payload.lines[1].role).toBe('旦')
    expect(payload.lines[0].cues[0].seconds).toBe(6)
  })
})
