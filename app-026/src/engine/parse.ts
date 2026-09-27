import type { Cue, Line, Segment } from '../types'
import { DEFAULT_CUE_SECONDS, HOLDABLE_KINDS, KIND_LABELS } from '../constants'

const NUM = '(\\d+(?:\\.\\d+)?)'

/** 行内标记语法：【过门5】/【过门:5】/【过门5秒】、【锣鼓】、【停顿3秒】、【注:xxx】 */
const CUE_PATTERNS: { kind: Cue['kind']; re: RegExp }[] = [
  { kind: 'pause', re: new RegExp(`【(?:停顿|间歇)(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'interlude', re: new RegExp(`【过门(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'drum', re: new RegExp(`【(?:锣鼓|亮相)(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'note', re: /【注[:：]([^\】]*)】/g },
]

/**
 * 放宽扫描：只要含停留关键字就认出来，用来发现
 * 「秒数写了零 / 不是数字 / 写法异常」的标记（严格语法会把它们静默留在唱词里）。
 */
const LOOSE_CUE_RE = /【(停顿|间歇|过门|锣鼓|亮相)([^】]*)】/g
const LOOSE_KIND: Record<string, Cue['kind']> = {
  停顿: 'pause',
  间歇: 'pause',
  过门: 'interlude',
  锣鼓: 'drum',
  亮相: 'drum',
}

export type PreviewIssueType = 'longRole' | 'unbalancedBrackets' | 'zeroSeconds' | 'badSeconds'

export interface PreviewIssue {
  type: PreviewIssueType
  reason: string
  /** 秒数问题对应到具体的停留标记，预览里就地改秒数即可消除 */
  cueId?: string
}

export interface ParsedResult {
  lines: Line[]
  segments: Segment[]
}

let idSeq = 0
function nextId(prefix: string) {
  idSeq += 1
  return `${prefix}_${idSeq}_${Math.random().toString(36).slice(2, 7)}`
}

export const PREVIEW_ISSUE_META: { type: PreviewIssueType; label: string }[] = [
  { type: 'longRole', label: '角色前缀超过六个字' },
  { type: 'unbalancedBrackets', label: '括号不配对' },
  { type: 'zeroSeconds', label: '秒数写了零' },
  { type: 'badSeconds', label: '秒数不是数字' },
]

interface LooseMatch {
  match: string
  kind: Cue['kind']
  /** 关键字之后、】之前的原文，如 「:6」「0」「五秒」 */
  body: string
}

/** 严格语法能接受的标记正文：空（用默认）、5 / :5 / 5秒 / :5秒（不允许夹杂空格） */
function strictAccepts(body: string): boolean {
  return body === '' || new RegExp(`^[:：]?${NUM}秒?$`).test(body)
}

/** 解析单行文本：抽取标记、剥离角色前缀「角色：」 */
export function parseContentLine(raw: string): { role?: string; text: string; cues: Cue[] } {
  const { role, text, cues } = analyzeContentLine(raw)
  return { role, text, cues }
}

/** 同 parseContentLine，额外返回预览用的逐行问题 */
function analyzeContentLine(rawInput: string): {
  role?: string
  text: string
  cues: Cue[]
  issues: PreviewIssue[]
} {
  const original = rawInput.trim()
  let text = original
  const cues: Cue[] = []
  const issues: PreviewIssue[] = []

  // 先放宽扫描一遍，拿到所有疑似停留标记（含写法异常的）
  const loose: LooseMatch[] = []
  LOOSE_CUE_RE.lastIndex = 0
  for (const m of original.matchAll(LOOSE_CUE_RE)) {
    loose.push({ match: m[0], kind: LOOSE_KIND[m[1]], body: m[2] })
  }

  for (const { kind, re } of CUE_PATTERNS) {
    text = text.replace(re, (match, n1?: string, n2?: string, n3?: string) => {
      if (kind === 'note') {
        // 注意：【注:xxx】只有一个捕获组 → xxx 落在 n1
        cues.push({ id: nextId('c'), kind, label: (n1 ?? '').trim() || undefined })
      } else {
        const secs = parseFloat(n1 ?? n2 ?? '')
        cues.push({
          id: nextId('c'),
          kind,
          // 写 0（或缺数字）时严格解析会静默回退到默认秒数
          seconds: Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_CUE_SECONDS[kind as 'pause'],
        })
      }
      void match
      void n3
      return ' '
    })
  }

  // 严格扫描按类别成组（停顿→过门→锣鼓），类别内按文中顺序
  const strictByKind: Record<string, Cue[]> = { pause: [], interlude: [], drum: [] }
  for (const c of cues) if (HOLDABLE_KINDS.includes(c.kind)) strictByKind[c.kind].push(c)
  const strictOrdinal: Record<string, number> = { pause: 0, interlude: 0, drum: 0 }

  for (const lm of loose) {
    const body = lm.body
    const name = KIND_LABELS[lm.kind]
    const fallback = DEFAULT_CUE_SECONDS[lm.kind as 'pause']

    if (strictAccepts(body)) {
      // 严格语法认识：对得上某个已解析标记；检查是不是 0
      strictOrdinal[lm.kind] += 1
      const cue = strictByKind[lm.kind][strictOrdinal[lm.kind] - 1]
      const num = parseFloat(body.replace(/^[:：]/, '').replace(/秒$/, ''))
      if (Number.isFinite(num) && num === 0 && cue) {
        issues.push({
          type: 'zeroSeconds',
          cueId: cue.id,
          reason: `「${name}」秒数写成了 0，无效，已按默认 ${fallback} 秒填入，可在下面直接改`,
        })
      }
      continue
    }

    // 严格语法不认识的写法：取出其中的数字，取不到就是「不是数字」
    const numM = body.match(/\d+(?:\.\d+)?/)
    const secs = numM ? parseFloat(numM[0]) : NaN
    const cue: Cue = {
      id: nextId('c'),
      kind: lm.kind,
      seconds: Number.isFinite(secs) && secs > 0 ? secs : fallback,
    }
    cues.push(cue)
    // 把这块无法识别的标记从唱词里摘掉，避免落进正文；预览中原行仍可见
    text = text.split(lm.match).join(' ')
    if (!Number.isFinite(secs) || secs <= 0) {
      issues.push({
        type: 'badSeconds',
        cueId: cue.id,
        reason: `「${name}」秒数写的是「${body}」，不是数字，未能识别；已先补一个默认 ${fallback} 秒的${name}，可在下面直接改秒数`,
      })
    }
  }

  text = text.replace(/\s{2,}/g, ' ').trim()

  // 角色前缀：冒号前 ≤6 字、不含标记括号，才算角色
  let role: string | undefined
  const m = text.match(/^([^【】：：]{1,6})[:：]\s*(.+)$/)
  if (m) {
    role = m[1].trim()
    text = m[2].trim()
  } else {
    // 超过 6 个字的前缀单独提示，预览里可就地补角色
    const long = text.match(/^([^【】：:]{7,})[:：]/)
    if (long) {
      issues.push({
        type: 'longRole',
        reason: `「${long[1]}」有 ${long[1].length} 个字，超过六个字，未识别为角色前缀，整行按唱词处理；可在下面角色栏直接补填`,
      })
    }
  }

  // 括号配对检查（只认行内标记使用的全角【】）
  const open = (original.match(/【/g) ?? []).length
  const close = (original.match(/】/g) ?? []).length
  if (open !== close) {
    issues.push({
      type: 'unbalancedBrackets',
      reason: `括号不配对：【 有 ${open} 个、】 有 ${close} 个，相关标记可能无法识别`,
    })
  }

  return { role, text, cues, issues }
}

const SEG_HEADER_RE = /^(?:#{1,3}\s*(.+)|【段[:：](.+?)】)\s*$/

interface WalkedRow {
  line: Line
  raw: string
  issues: PreviewIssue[]
}

/**
 * 粘贴文本 → 行 / 段（parseScriptText 与预览共用，保证预览所见即写入所得）。
 * - 「## 标题」或「【段：标题】」为唱段头
 * - 空行自动分段（autoSegmentOnBlank，默认开）
 * - 行内标记见 CUE_PATTERNS
 */
function walkScriptText(
  raw: string,
  opts: { autoSegmentOnBlank?: boolean } = {},
): { lines: Line[]; segments: Segment[]; rows: WalkedRow[] } {
  const autoBlank = opts.autoSegmentOnBlank !== false
  const lines: Line[] = []
  const segments: Segment[] = []
  const rows: WalkedRow[] = []
  let current: Segment | null = null
  let autoIdx = 0

  const closeCurrent = () => {
    if (current && current.lineIds.length >= 0) segments.push(current)
    current = null
  }
  const openSegment = (title?: string) => {
    closeCurrent()
    autoIdx += 1
    current = { id: nextId('s'), title: title?.trim() || `第${autoIdx}段`, lineIds: [] }
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed === '') {
      if (autoBlank) closeCurrent()
      continue
    }
    const header = trimmed.match(SEG_HEADER_RE)
    if (header) {
      openSegment(header[1] ?? header[2])
      continue
    }
    const parsed = analyzeContentLine(trimmed)
    const line: Line = {
      id: nextId('l'),
      role: parsed.role,
      text: parsed.text,
      cues: parsed.cues,
      marks: [],
    }
    lines.push(line)
    rows.push({ line, raw: trimmed, issues: parsed.issues })
    if (!current) {
      autoIdx += 1
      current = { id: nextId('s'), title: `第${autoIdx}段`, lineIds: [] }
    }
    current.lineIds.push(line.id)
  }
  closeCurrent()

  // 空文本行的过门标记补个占位文本，避免渲染空行
  for (const line of lines) {
    if (line.text === '' && line.cues.some((c) => c.kind !== 'note')) {
      line.text = '—— 过门 ——'
    }
  }
  if (lines.length === 0) {
    const seg: Segment = { id: nextId('s'), title: '第1段', lineIds: [] }
    return { lines, segments: [seg], rows }
  }
  return { lines, segments, rows }
}

export function parseScriptText(
  raw: string,
  opts: { autoSegmentOnBlank?: boolean } = {},
): ParsedResult {
  const { lines, segments } = walkScriptText(raw, opts)
  return { lines, segments }
}

/* ============ 粘贴预览 ============ */

export interface PreviewLine {
  /** 全文顺序的行号，从 1 开始 */
  globalNo: number
  line: Line
  /** 所在唱段 id */
  segId: string | null
  /** 粘贴的原始行 */
  raw: string
  issues: PreviewIssue[]
}

export interface PreviewSegment {
  id: string
  title: string
  /** 解析结果中的段序号，从 0 开始 */
  index: number
  lineIds: string[]
  empty: boolean
}

export interface PreviewResult {
  lines: PreviewLine[]
  segments: PreviewSegment[]
  segmentCount: number
  lineCount: number
  /** 问题总条数（一行可能有多条） */
  issueCount: number
  /** 有问题的行数 */
  issueLineCount: number
  counts: Record<PreviewIssueType, number>
}

/** 解析并生成预览数据（不写任何东西），段/句统计、同段归属、逐行问题一并给出 */
export function previewScriptText(
  raw: string,
  opts: { autoSegmentOnBlank?: boolean } = {},
): PreviewResult {
  const { lines, segments, rows } = walkScriptText(raw, opts)

  const segOfLine = new Map<string, string>()
  for (const seg of segments) for (const lid of seg.lineIds) segOfLine.set(lid, seg.id)

  const pvLines: PreviewLine[] = rows.map((row, i) => ({
    globalNo: i + 1,
    line: row.line,
    segId: segOfLine.get(row.line.id) ?? null,
    raw: row.raw,
    issues: row.issues,
  }))

  const pvSegments: PreviewSegment[] = segments.map((seg, i) => ({
    id: seg.id,
    title: seg.title,
    index: i,
    lineIds: seg.lineIds,
    empty: seg.lineIds.length === 0,
  }))

  const counts = { longRole: 0, unbalancedBrackets: 0, zeroSeconds: 0, badSeconds: 0 } as Record<
    PreviewIssueType,
    number
  >
  let issueCount = 0
  for (const pl of pvLines) {
    for (const iss of pl.issues) {
      counts[iss.type] += 1
      issueCount += 1
    }
  }

  return {
    lines: pvLines,
    segments: pvSegments,
    segmentCount: pvSegments.length,
    lineCount: lines.length,
    issueCount,
    issueLineCount: pvLines.filter((l) => l.issues.length > 0).length,
    counts,
  }
}

export function buildScriptFromText(
  title: string,
  raw: string,
  style: 'opera' | 'speech',
  troupe?: string,
): { id: string; title: string; troupe?: string; lines: Line[]; segments: Segment[]; style: 'opera' | 'speech'; updatedAt: number } {
  const { lines, segments } = parseScriptText(raw)
  return {
    id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    troupe,
    lines,
    segments,
    style,
    updatedAt: Date.now(),
  }
}
