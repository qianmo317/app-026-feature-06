import { describe, expect, it } from 'vitest'
import { parseScriptText, parseContentLine, previewScriptText } from '../../src/engine/parse'
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

describe('粘贴预览：问题逐行标出', () => {
  it('全部正常时不计问题', () => {
    const pv = previewScriptText('生：第一句【过门5】\n旦：第二句【锣鼓】')
    expect(pv.segmentCount).toBe(1)
    expect(pv.lineCount).toBe(2)
    expect(pv.issueCount).toBe(0)
    expect(pv.issueLineCount).toBe(0)
  })

  it('角色前缀超过六个字单独标出', () => {
    const pv = previewScriptText('幕后合唱念白员：这一句前缀太长')
    expect(pv.counts.longRole).toBe(1)
    expect(pv.lines[0].line.role).toBeUndefined()
    expect(pv.lines[0].issues[0].type).toBe('longRole')
    expect(pv.lines[0].issues[0].reason).toContain('超过六个字')
  })

  it('括号不配对标出，并给出两边个数', () => {
    const pv = previewScriptText('生：唱一句【过门5】再唱【锣鼓')
    expect(pv.counts.unbalancedBrackets).toBe(1)
    const iss = pv.lines[0].issues.find((i) => i.type === 'unbalancedBrackets')
    expect(iss?.reason).toContain('【 有 2 个')
    expect(iss?.reason).toContain('】 有 1 个')
  })

  it('秒数写 0 标出并提示默认值，cue 仍有秒数可改', () => {
    const pv = previewScriptText('生：唱【过门0】')
    expect(pv.counts.zeroSeconds).toBe(1)
    const iss = pv.lines[0].issues.find((i) => i.type === 'zeroSeconds')
    expect(iss?.cueId).toBeTruthy()
    expect(iss?.reason).toContain('默认 4 秒')
    const cue = pv.lines[0].line.cues.find((c) => c.id === iss!.cueId)
    expect(cue?.seconds).toBe(4)
  })

  it('秒数不是数字标出：从唱词摘除并补默认秒数', () => {
    const pv = previewScriptText('生：唱【停顿五秒】收')
    expect(pv.counts.badSeconds).toBe(1)
    expect(pv.lines[0].line.text).toBe('唱 收')
    const cue = pv.lines[0].line.cues[0]
    expect(cue).toMatchObject({ kind: 'pause', seconds: 2 })
    expect(pv.lines[0].issues[0].cueId).toBe(cue.id)
  })

  it('一行多个问题同时标出', () => {
    const pv = previewScriptText('超长角色名带很多字啊：唱【过门0】【停顿abc】【多的括号')
    const types = pv.lines[0].issues.map((i) => i.type).sort()
    expect(types).toEqual(['badSeconds', 'longRole', 'unbalancedBrackets', 'zeroSeconds'])
  })

  it('统计段数/句数，并标出哪些行落在同一段', () => {
    const pv = previewScriptText('## 起\n生：A\n生：B\n\n旦：C')
    expect(pv.segmentCount).toBe(2)
    expect(pv.lineCount).toBe(3)
    expect(pv.segments.map((s) => s.lineIds.length)).toEqual([2, 1])
    expect(pv.lines[0].segId).toBe(pv.lines[1].segId)
    expect(pv.lines[2].segId).not.toBe(pv.lines[0].segId)
    expect(pv.lines.map((l) => l.globalNo)).toEqual([1, 2, 3])
    expect(pv.lines[2].raw).toBe('旦：C')
  })

  it('段头后直接空行的空段标出', () => {
    const pv = previewScriptText('## 只有标题\n\n生：A')
    expect(pv.segments[0].empty).toBe(true)
    expect(pv.segments[1].empty).toBe(false)
  })

  it('预览与实际解析产出一致（除 id 外内容相同）', () => {
    const raw = '生：A【过门3】\n\n旦：B'
    const parsed = parseScriptText(raw)
    const pv = previewScriptText(raw)
    // 两次解析各自生成 id，只比对结构内容，保证预览所见即写入所得
    expect(pv.lines.map((l) => ({ role: l.line.role, text: l.line.text, cues: l.line.cues.length }))).toEqual(
      parsed.lines.map((l) => ({ role: l.role, text: l.text, cues: l.cues.length })),
    )
    expect(pv.segments.map((s) => s.lineIds.length)).toEqual(parsed.segments.map((s) => s.lineIds.length))
  })
})
