import type { Cue, Line, Segment } from '../types'
import { DEFAULT_CUE_SECONDS } from '../constants'

const NUM = '(\\d+(?:\\.\\d+)?)'

/** 行内标记语法：【过门5】/【过门:5】/【过门5秒】、【锣鼓】、【停顿3秒】、【注:xxx】 */
const CUE_PATTERNS: { kind: Cue['kind']; re: RegExp }[] = [
  { kind: 'pause', re: new RegExp(`【(?:停顿|间歇)(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'interlude', re: new RegExp(`【过门(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'drum', re: new RegExp(`【(?:锣鼓|亮相)(?:[:：]${NUM}|${NUM}秒?)?】`, 'g') },
  { kind: 'note', re: /【注[:：]([^\】]*)】/g },
]

export interface ParsedResult {
  lines: Line[]
  segments: Segment[]
}

let idSeq = 0
function nextId(prefix: string) {
  idSeq += 1
  return `${prefix}_${idSeq}_${Math.random().toString(36).slice(2, 7)}`
}

/** 解析单行文本：抽取标记、剥离角色前缀「角色：」。stripped 为抽掉标记但尚未剥离角色的文本（供预览诊断） */
export function parseContentLine(raw: string, opts: { keepZeroSeconds?: boolean } = {}): {
  role?: string
  text: string
  stripped: string
  cues: Cue[]
} {
  let text = raw.trim()
  const cues: Cue[] = []

  for (const { kind, re } of CUE_PATTERNS) {
    text = text.replace(re, (match, n1?: string, n2?: string, n3?: string) => {
      if (kind === 'note') {
        // 注意：【注:xxx】只有一个捕获组 → xxx 落在 n1
        cues.push({ id: nextId('c'), kind, label: (n1 ?? '').trim() || undefined })
      } else {
        const secs = parseFloat(n1 ?? n2 ?? '')
        const parsed = Number.isFinite(secs) ? secs : undefined
        cues.push({
          id: nextId('c'),
          kind,
          seconds:
            parsed !== undefined && parsed > 0
              ? parsed
              : opts.keepZeroSeconds && parsed === 0
                ? 0
                : DEFAULT_CUE_SECONDS[kind as 'pause'],
        })
      }
      void match
      void n3
      return ' '
    })
  }
  text = text.replace(/\s{2,}/g, ' ').trim()
  const stripped = text

  // 角色前缀：冒号前 ≤6 字、不含标记括号，才算角色
  let role: string | undefined
  const m = text.match(/^([^【】：：]{1,6})[:：]\s*(.+)$/)
  if (m) {
    role = m[1].trim()
    text = m[2].trim()
  }

  return { role, text, stripped, cues }
}

const SEG_HEADER_RE = /^(?:#{1,3}\s*(.+)|【段[:：](.+?)】)\s*$/

interface RunRow {
  raw: string
  line: Line
  parsed: ReturnType<typeof parseContentLine>
}

export interface RunOptions {
  autoSegmentOnBlank?: boolean
  /** 自动段标题的起始序号（追加到现有文稿时用，避免「第1段」重名） */
  autoSegmentStart?: number
  /** 保留 0 秒标记的原始值（预览诊断用，正式写入时应再归一为默认秒数） */
  keepZeroSeconds?: boolean
}

/**
 * 粘贴文本解析主流程。
 * - 「## 标题」或「【段：标题】」为唱段头
 * - 空行自动分段（autoSegmentOnBlank，默认开）
 * - 行内标记见 CUE_PATTERNS
 */
function runParse(raw: string, opts: RunOptions = {}): { lines: Line[]; segments: Segment[]; rows: RunRow[] } {
  const autoBlank = opts.autoSegmentOnBlank !== false
  const lines: Line[] = []
  const segments: Segment[] = []
  const rows: RunRow[] = []
  let current: Segment | null = null
  let autoIdx = (opts.autoSegmentStart ?? 1) - 1

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
    const parsed = parseContentLine(trimmed, { keepZeroSeconds: opts.keepZeroSeconds })
    const line: Line = {
      id: nextId('l'),
      role: parsed.role,
      text: parsed.text,
      cues: parsed.cues,
      marks: [],
    }
    lines.push(line)
    rows.push({ raw: trimmed, line, parsed })
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
    segments.push({ id: nextId('s'), title: '第1段', lineIds: [] })
  }
  return { lines, segments, rows }
}

/**
 * 粘贴文本 → { lines, segments }。
 */
export function parseScriptText(
  raw: string,
  opts: { autoSegmentOnBlank?: boolean; autoSegmentStart?: number } = {},
): ParsedResult {
  const { lines, segments } = runParse(raw, opts)
  return { lines, segments }
}

/* ===================== 粘贴预览：逐行诊断 ===================== */

export type PreviewIssueKind = 'role-long' | 'unpaired-bracket' | 'seconds-zero' | 'seconds-nan'

export interface PreviewIssue {
  kind: PreviewIssueKind
  /** 人类可读原因 */
  reason: string
  /** seconds-zero：命中的 cue id；seconds-nan：行内括号片段原文 */
  cueId?: string
  token?: string
  /** seconds-zero：标记类型（cue 按模式顺序生成，需按类型配对） */
  cueKind?: Cue['kind']
}

export interface PreviewRow {
  raw: string
  line: Line
  segIndex: number
  lineNo: number
  issues: PreviewIssue[]
}

export interface ScriptPreview {
  rows: PreviewRow[]
  lines: Line[]
  segments: Segment[]
}

/** 带秒数的标记关键字 */
const TIMED_KEYWORD_RE = /^(停顿|间歇|过门|锣鼓|亮相)(.*)$/

const TIMED_KIND_OF: Record<string, Cue['kind']> = {
  停顿: 'pause',
  间歇: 'pause',
  过门: 'interlude',
  锣鼓: 'drum',
  亮相: 'drum',
}

/** 诊断单行：括号配对、秒数（0 / 非数字）、角色前缀过长 */
export function diagnoseLine(
  rawLine: string,
  parsed: ReturnType<typeof parseContentLine>,
): PreviewIssue[] {
  const issues: PreviewIssue[] = []

  // 括号配对：逐个配对，多余的任一半边都算没配对
  const opens = (rawLine.match(/【/g) ?? []).length
  const closes = (rawLine.match(/】/g) ?? []).length
  if (opens !== closes) {
    issues.push({
      kind: 'unpaired-bracket',
      reason:
        opens > closes
          ? `有 ${opens - closes} 个「【」缺少配对的「】」，括号内标记无法识别`
          : `有 ${closes - opens} 个「】」缺少配对的「【」，括号内标记无法识别`,
    })
  }

  // 秒数：0 或不是数字
  const spans = [...rawLine.matchAll(/【([^】]*)】/g)].map((m) => m[1])
  for (const span of spans) {
    const km = span.match(TIMED_KEYWORD_RE)
    if (!km) continue
    const kindName = km[1]
    let rest = km[2].trim()
    rest = rest.replace(/^[:：]/, '').trim()
    const mNum = rest.match(/^(\d+(?:\.\d+)?)秒?$/)
    if (rest === '') continue // 未写秒数 → 默认值，正常
    if (mNum) {
      if (parseFloat(mNum[1]) === 0) {
        issues.push({
          kind: 'seconds-zero',
          reason: `【${span}】秒数写了 0，已先按默认秒数处理，请在预览里改成正数`,
          token: `【${span}】`,
          cueKind: TIMED_KIND_OF[kindName],
        })
      }
    } else {
      issues.push({
        kind: 'seconds-nan',
        reason: `【${span}】秒数「${rest}」不是数字，未识别为${kindName}标记，目前按普通唱词保留`,
        token: `【${span}】`,
      })
    }
  }

  // 角色前缀超过 6 字（用抽掉标记后的文本判断，避免被行内标记干扰）
  const rm = parsed.stripped.match(/^([^【】：:]{7,})[:：]/)
  if (rm && !parsed.role) {
    const prefix = rm[1]
    issues.push({
      kind: 'role-long',
      reason: `「${prefix}」作为角色前缀有 ${prefix.length} 个字（超过 6 个），未识别为角色，整行按唱词保留；在下方补上角色可把前缀剥掉`,
      token: prefix,
    })
  }

  return issues
}

/**
 * 粘贴预览：解析 + 逐行诊断（不动正文）。
 * 返回每行所属段、句序号与问题原因。
 */
export function previewScriptText(raw: string, opts: { autoSegmentOnBlank?: boolean; autoSegmentStart?: number } = {}): ScriptPreview {
  const { lines, segments, rows } = runParse(raw, { ...opts, keepZeroSeconds: true })

  // line id → 段序号
  const segOfLine = new Map<string, number>()
  segments.forEach((seg, si) => {
    for (const lid of seg.lineIds) segOfLine.set(lid, si)
  })

  const previewRows: PreviewRow[] = rows.map((r, i) => {
    const issues = diagnoseLine(r.raw, r.parsed)
    // seconds-zero：cue 按「停顿→过门→锣鼓」模式顺序生成，与原文括号顺序不同，
    // 需按标记类型分别把第 n 个 0 秒问题对应到第 n 个 0 秒 cue
    const zeroIdsByKind = new Map<Cue['kind'], string[]>()
    for (const c of r.line.cues) {
      if (c.kind !== 'note' && c.seconds === 0) {
        const list = zeroIdsByKind.get(c.kind) ?? []
        list.push(c.id)
        zeroIdsByKind.set(c.kind, list)
      }
    }
    const usedByKind = new Map<Cue['kind'], number>()
    for (const iss of issues) {
      if (iss.kind === 'seconds-zero' && iss.cueKind) {
        const ord = usedByKind.get(iss.cueKind) ?? 0
        iss.cueId = zeroIdsByKind.get(iss.cueKind)?.[ord]
        usedByKind.set(iss.cueKind, ord + 1)
      }
    }
    return { raw: r.raw, line: r.line, segIndex: segOfLine.get(r.line.id) ?? 0, lineNo: i + 1, issues }
  })

  return { rows: previewRows, lines, segments }
}

/** 预览确认后归一：仍为 0 / 缺省的停留标记秒数回落到默认值 */
export function normalizePreviewCues(lines: Line[]): Line[] {
  return lines.map((line) => ({
    ...line,
    cues: line.cues.map((c) =>
      c.kind === 'note' || (c.seconds !== undefined && c.seconds > 0)
        ? c
        : { ...c, seconds: DEFAULT_CUE_SECONDS[c.kind as 'pause'] },
    ),
  }))
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
