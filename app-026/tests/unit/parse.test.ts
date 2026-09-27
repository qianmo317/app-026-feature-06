import { describe, expect, it } from 'vitest'
import {
  parseScriptText,
  parseContentLine,
  previewScriptText,
  diagnoseLine,
  normalizePreviewCues,
} from '../../src/engine/parse'
import { lineHoldSeconds } from '../../src/engine/cues'

describe('「角色：唱词」解析', () => {
  it('识别短角色前缀', () => {
    const { role, text } = parseContentLine('旦：尊一声驸马爷细听咱言')
    expect(role).toBe('旦')
    expect(text).toBe('尊一声驸马爷细听咱言')
  })

  it('冒号前过长则不算角色', () => {
    const { role, text } = parseContentLine('这一句太长了不应该算角色：后面的字')
    expect(role).toBeUndefined()
    expect(text).toContain('：')
  })
})

describe('行内标记解析', () => {
  it('【过门5】【锣鼓】【停顿3】与默认秒数', () => {
    const { text, cues } = parseContentLine('唱一句【过门5】再唱【锣鼓】收【停顿3秒】')
    expect(text).toBe('唱一句 再唱 收')
    expect(cues.map((c) => [c.kind, c.seconds])).toEqual([
      ['pause', 3],
      ['interlude', 5],
      ['drum', 2], // 默认 2s
    ])
  })

  it('【过门:6】冒号写法；【注:xxx】不停留', () => {
    const a = parseContentLine('老娘亲来到白马关【过门:6】')
    expect(a.cues[0]).toMatchObject({ kind: 'interlude', seconds: 6 })

    const b = parseContentLine('听罢言来吃一惊【注:瞪眼、起身】')
    expect(b.text).toBe('听罢言来吃一惊')
    expect(b.cues[0]).toMatchObject({ kind: 'note', label: '瞪眼、起身' })
    expect(lineHoldSeconds({ id: 'x', text: '', cues: b.cues, marks: [] })).toBe(0)
  })

  it('独立过门行生成占位文本且可停留', () => {
    const { lines } = parseScriptText('生：第一句\n【过门5】\n生：第二句', { autoSegmentOnBlank: false })
    expect(lines[1].text).toContain('过门')
    expect(lineHoldSeconds(lines[1])).toBe(5)
  })
})

describe('唱段切分', () => {
  it('「## 标题」分段 + 空行自动分段', () => {
    const { lines, segments } = parseScriptText(
      '## 第一段\n生：A1\n生：A2\n\n旦：B1\n【段：过场】\n生：C1',
    )
    expect(lines.length).toBe(4)
    expect(segments.map((s) => s.title)).toEqual(['第一段', '第2段', '过场'])
    expect(segments[0].lineIds.length).toBe(2)
    expect(segments[1].lineIds).toEqual([lines[2].id])
  })

  it('关闭空行分段则全文一段', () => {
    const { segments } = parseScriptText('生：A\n\n旦：B', { autoSegmentOnBlank: false })
    expect(segments.length).toBe(1)
  })

  it('空输入返回单空段', () => {
    const { lines, segments } = parseScriptText('   \n  \n')
    expect(lines.length).toBe(0)
    expect(segments.length).toBe(1)
  })

  it('lineIds 与 lines 一一对应', () => {
    const { lines, segments } = parseScriptText('生：A\n\n旦：B\n生：C')
    const all = segments.flatMap((s) => s.lineIds)
    expect(all.slice().sort()).toEqual(lines.map((l) => l.id).slice().sort())
  })
})

describe('粘贴预览：逐行诊断', () => {
  const kinds = (raw: string) =>
    previewScriptText(raw, { autoSegmentOnBlank: false }).rows.flatMap((r) => r.issues.map((i) => i.kind))

  it('正常行无问题', () => {
    const pv = previewScriptText('生：尊一声驸马爷细听咱言【过门5】【锣鼓】', { autoSegmentOnBlank: false })
    expect(pv.rows).toHaveLength(1)
    expect(pv.rows[0].issues).toEqual([])
    expect(pv.rows[0].line.role).toBe('生')
    expect(pv.rows[0].line.cues.map((c) => c.seconds)).toEqual([5, 2])
  })

  it('角色前缀超过六个字标出原因', () => {
    const ks = kinds('这一句太长了不应该算角色：后面的字')
    expect(ks).toEqual(['role-long'])
    const { rows } = previewScriptText('这一句太长了不应该算角色：后面的字', { autoSegmentOnBlank: false })
    expect(rows[0].issues[0].reason).toContain('超过 6')
    expect(rows[0].line.role).toBeUndefined()
  })

  it('括号没配对（缺右括号/缺左括号）', () => {
    expect(kinds('生：唱一句【过门5】再唱【停顿3')).toContain('unpaired-bracket')
    expect(kinds('生：唱一句过门5】')).toContain('unpaired-bracket')
  })

  it('秒数为零标出且保留 0 值供就地修改', () => {
    const pv = previewScriptText('生：唱【过门0】【停顿0秒】', { autoSegmentOnBlank: false })
    const issues = pv.rows[0].issues
    expect(issues.map((i) => i.kind)).toEqual(['seconds-zero', 'seconds-zero'])
    // cue 按「停顿→过门→锣鼓」模式顺序生成，问题按原文顺序；需按类型配对
    const byKind = Object.fromEntries(pv.rows[0].line.cues.map((c) => [c.kind, c.id]))
    expect(issues[0].cueId).toBe(byKind.interlude)
    expect(issues[1].cueId).toBe(byKind.pause)
    expect(pv.rows[0].line.cues.map((c) => c.seconds)).toEqual([0, 0])
  })

  it('秒数不是数字标出，且不生成对应 cue', () => {
    const pv = previewScriptText('生：唱【过门abc】再唱【停顿:x】', { autoSegmentOnBlank: false })
    const issues = pv.rows[0].issues
    expect(issues.map((i) => i.kind)).toEqual(['seconds-nan', 'seconds-nan'])
    expect(issues[0].reason).toContain('abc')
    expect(pv.rows[0].line.cues).toEqual([])
    expect(pv.rows[0].line.text).toContain('过门abc')
  })

  it('段数、句数与同段归属', () => {
    const pv = previewScriptText('## 头段\n生：A\n生：B\n\n旦：C')
    expect(pv.segments).toHaveLength(2)
    expect(pv.rows).toHaveLength(3)
    expect(pv.rows.slice(0, 2).map((r) => r.segIndex)).toEqual([0, 0])
    expect(pv.rows[2].segIndex).toBe(1)
    expect(pv.rows.map((r) => r.lineNo)).toEqual([1, 2, 3])
  })

  it('追加时自动段序号接在现有段之后', () => {
    const pv = previewScriptText('生：A\n\n旦：B', { autoSegmentStart: 4 })
    expect(pv.segments.map((s) => s.title)).toEqual(['第4段', '第5段'])
  })

  it('空输入：0 句 + 单空段', () => {
    const pv = previewScriptText('  \n ')
    expect(pv.rows).toHaveLength(0)
    expect(pv.segments).toHaveLength(1)
  })

  it('diagnoseLine：多种问题可并存', () => {
    const parsed = parseContentLine('这一句太长了不应该算角色：唱【过门x】【停顿0')
    const ks = diagnoseLine('这一句太长了不应该算角色：唱【过门x】【停顿0', parsed).map((i) => i.kind)
    expect(ks).toEqual(expect.arrayContaining(['role-long', 'unpaired-bracket']))
  })

  it('确认时未修正的 0 秒回落默认值', () => {
    const pv = previewScriptText('生：唱【过门0】', { autoSegmentOnBlank: false })
    const fixed = normalizePreviewCues(pv.lines)
    expect(fixed[0].cues[0].seconds).toBe(4)
    expect(lineHoldSeconds(fixed[0])).toBe(4)
  })
})
