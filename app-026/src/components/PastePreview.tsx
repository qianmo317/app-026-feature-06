import { useMemo, useState } from 'react'
import {
  type PreviewIssue,
  type PreviewRow,
  type ScriptPreview,
  normalizePreviewCues,
} from '../engine/parse'
import type { Line, Segment } from '../types'
import { KIND_LABELS } from '../constants'
import { cueLabel } from '../engine/cues'

export type PasteMode = 'replace' | 'append'

const ISSUE_META: { kind: PreviewIssue['kind']; label: string; color: string }[] = [
  { kind: 'role-long', label: '角色前缀超六字', color: '#ffb020' },
  { kind: 'unpaired-bracket', label: '括号没配对', color: '#ff5d5d' },
  { kind: 'seconds-zero', label: '秒数为零', color: '#c98bff' },
  { kind: 'seconds-nan', label: '秒数不是数字', color: '#ff7a45' },
]

const ISSUE_STYLE: Record<PreviewIssue['kind'], { color: string }> = {
  'role-long': { color: '#ffb020' },
  'unpaired-bracket': { color: '#ff5d5d' },
  'seconds-zero': { color: '#c98bff' },
  'seconds-nan': { color: '#ff7a45' },
}

interface Props {
  mode: PasteMode
  preview: ScriptPreview
  /** 追加时：现有文稿末段标题（为 null 表示文稿为空） */
  appendAfter: { index: number; title: string } | null
  onConfirm: (lines: Line[], segments: Segment[]) => void
  onCancel: () => void
}

export function PastePreview({ mode, preview, appendAfter, onConfirm, onCancel }: Props) {
  // 预览数据是一次性的本地草稿，就地修改；确认前不会触碰正文
  const [rows, setRows] = useState<PreviewRow[]>(preview.rows)
  const [lines, setLines] = useState<Line[]>(preview.lines)
  const [onlyIssues, setOnlyIssues] = useState(false)

  const patchLine = (lineId: string, fn: (l: Line) => Line, dropIssues?: (iss: PreviewIssue) => boolean) => {
    setLines((ls) => ls.map((l) => (l.id === lineId ? fn(l) : l)))
    setRows((rs) =>
      rs.map((r) =>
        r.line.id !== lineId
          ? r
          : { ...r, line: fn(r.line), issues: dropIssues ? r.issues.filter((i) => !dropIssues(i)) : r.issues },
      ),
    )
  }

  /** 就地改角色；从过长前缀修复时，把唱词开头的「前缀：」剥掉（清空角色则加回） */
  const setRole = (row: PreviewRow, role: string) => {
    const roleIssue = row.issues.find((i) => i.kind === 'role-long')
    const prefix = roleIssue?.token
    patchLine(
      row.line.id,
      (l) => {
        let text = l.text
        if (roleIssue && prefix) {
          if (role) {
            text = l.text.startsWith(prefix) ? l.text.slice(prefix.length).replace(/^[:：]\s*/, '') : l.text
          } else {
            text = `${prefix}：${l.text}`
          }
        }
        return { ...l, role: role || undefined, text }
      },
      (iss) => iss.kind === 'role-long' && !!role,
    )
  }

  /** 就地改已识别标记的秒数；改成正数后秒数为零的提示消失 */
  const setCueSeconds = (lineId: string, cueId: string, raw: string) => {
    const secs = parseFloat(raw)
    const valid = Number.isFinite(secs) && secs > 0
    patchLine(
      lineId,
      (l) => ({
        ...l,
        cues: l.cues.map((c) => (c.id === cueId ? { ...c, seconds: valid ? secs : 0 } : c)),
      }),
      (iss) => iss.kind === 'seconds-zero' && iss.cueId === cueId && valid,
    )
  }

  /** 「秒数不是数字」的就地修复：把括号片段替换成合法标记并补进该行 */
  const adoptCue = (row: PreviewRow, issue: PreviewIssue, seconds: number) => {
    if (!issue.token || !Number.isFinite(seconds) || seconds <= 0) return
    const span = issue.token
    const keyword = span.slice(1, -1).match(/^(停顿|间歇|过门|锣鼓|亮相)/)?.[1]
    const kindMap: Record<string, Line['cues'][number]['kind']> = {
      停顿: 'pause',
      间歇: 'pause',
      过门: 'interlude',
      锣鼓: 'drum',
      亮相: 'drum',
    }
    const kind = keyword ? kindMap[keyword] : undefined
    if (!kind) return
    const cue: Line['cues'][number] = {
      id: `c_fix_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      seconds,
    }
    patchLine(
      row.line.id,
      (l) => {
        // 以片段在行内的出现位置插入，保持标记顺序
        const idxInRaw = row.raw.indexOf(span)
        let before = 0
        if (idxInRaw > 0) {
          const beforeText = row.raw.slice(0, idxInRaw)
          before = (beforeText.match(/【[^】]*】/g) ?? []).length
        }
        const cues = l.cues.slice()
        cues.splice(Math.min(before, cues.length), 0, cue)
        // 把原文里的字面片段从唱词中剥掉（仅剥这一处），避免写入后仍显示括号
        const at = l.text.indexOf(span)
        const text = at >= 0 ? `${l.text.slice(0, at)} ${l.text.slice(at + span.length)}`.replace(/\s{2,}/g, ' ').trim() : l.text
        return { ...l, cues, text }
      },
      (iss) => iss === issue,
    )
  }

  const issueCounts = useMemo(() => {
    const counts: Record<PreviewIssue['kind'], number> = {
      'role-long': 0,
      'unpaired-bracket': 0,
      'seconds-zero': 0,
      'seconds-nan': 0,
    }
    for (const r of rows) for (const i of r.issues) counts[i.kind] += 1
    return counts
  }, [rows])

  const problemCount = rows.filter((r) => r.issues.length > 0).length
  const visibleRows = onlyIssues ? rows.filter((r) => r.issues.length > 0) : rows
  const shownSegs = new Set(visibleRows.map((r) => r.segIndex))

  const confirm = () => {
    onConfirm(normalizePreviewCues(lines), preview.segments)
  }

  return (
    <div className="modal" data-testid="paste-preview" onClick={onCancel}>
      <div className="modal-box modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'replace' ? '预览：替换全篇' : '预览：追加到末尾'}</h3>

        <div className="pv-summary" data-testid="pv-summary">
          <strong>
            共 {preview.segments.length} 段 · {rows.length} 句
          </strong>
          <span className={problemCount ? 'pv-bad' : 'ok'} data-testid="pv-ok-count">
            {rows.length - problemCount} 行正常识别
          </span>
          {ISSUE_META.filter((m) => issueCounts[m.kind] > 0).map((m) => (
            <span
              key={m.kind}
              className="pv-tag"
              data-testid={`pv-count-${m.kind}`}
              style={{ borderColor: m.color, color: m.color }}
            >
              {m.label} {issueCounts[m.kind]}
            </span>
          ))}
          <label className="chk">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            只看有问题的行
          </label>
        </div>

        {mode === 'append' ? (
          <p className="pv-anchor" data-testid="pv-anchor">
            {appendAfter
              ? <>将接在现有文稿最后一段「<strong>{appendAfter.title}</strong>」（第 {appendAfter.index + 1} 段）之后写入，追加段从第 {appendAfter.index + 2} 段开始。</>
              : '现有文稿为空，追加内容将从第 1 段开始。'}
          </p>
        ) : (
          <p className="pv-anchor muted" data-testid="pv-anchor">确认后将用以下内容替换全篇，现有正文会被覆盖。</p>
        )}

        {rows.length === 0 && <p className="muted">没有可解析的句子，请先在上方粘贴唱词。</p>}

        <div className="pv-body" data-testid="pv-body">
          {preview.segments.map((seg, si) =>
            shownSegs.has(si) ? (
              <div key={seg.id} className="pv-seg" data-testid="pv-seg">
                <div className="pv-seg-head">
                  {mode === 'append' && appendAfter ? `第 ${appendAfter.index + 1 + si + 1} 段（新）` : `第 ${si + 1} 段`}
                  {' · '}
                  {seg.title} · {seg.lineIds.length} 句
                </div>
                {visibleRows
                  .filter((r) => r.segIndex === si)
                  .map((row) => (
                    <PreviewLineView
                      key={row.line.id}
                      row={row}
                      onRole={(v) => setRole(row, v)}
                      onSeconds={(cueId, v) => setCueSeconds(row.line.id, cueId, v)}
                      onAdopt={(iss, secs) => adoptCue(row, iss, secs)}
                    />
                  ))}
              </div>
            ) : null,
          )}
        </div>

        <div className="pv-foot">
          <span className="muted">可直接在上方修改角色与秒数；确认前不会改动现有文稿。</span>
          <div>
            <button className="btn btn-ghost" data-testid="pv-cancel" onClick={onCancel}>
              取消
            </button>
            <button
              className={`btn ${mode === 'replace' ? 'btn-danger' : ''}`}
              data-testid="pv-confirm"
              disabled={rows.length === 0}
              onClick={confirm}
            >
              {mode === 'replace' ? '确认替换全篇' : '确认追加到末尾'}
              {problemCount > 0 ? '（仍有提示未处理）' : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PreviewLineView({
  row,
  onRole,
  onSeconds,
  onAdopt,
}: {
  row: PreviewRow
  onRole: (v: string) => void
  onSeconds: (cueId: string, v: string) => void
  onAdopt: (iss: PreviewIssue, seconds: number) => void
}) {
  const line = row.line
  return (
    <div
      className={`pv-row${row.issues.length ? ' has-issue' : ''}`}
      data-testid="pv-row"
      data-issues={row.issues.map((i) => i.kind).join(' ') || undefined}
    >
      <span className="pv-no">{row.lineNo}</span>
      <div className="pv-main">
        <div className="pv-line">
          <input
            className="pv-role"
            aria-label="角色"
            placeholder="角色"
            value={line.role ?? ''}
            onChange={(e) => onRole(e.target.value)}
          />
          <span className="pv-text">{line.text || <em className="muted">（无唱词正文）</em>}</span>
        </div>
        {line.cues.length > 0 && (
          <div className="pv-cues">
            {line.cues.map((c) => {
              const zeroIssue = row.issues.find((i) => i.kind === 'seconds-zero' && i.cueId === c.id)
              return (
                <span className={`cue-chip${zeroIssue ? ' cue-warn' : ''}`} key={c.id} data-kind={c.kind}>
                  {c.kind === 'note' ? (
                    cueLabel(c)
                  ) : (
                    <>
                      {KIND_LABELS[c.kind]}
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        aria-label={`${KIND_LABELS[c.kind]}秒数`}
                        value={c.seconds ?? 0}
                        onChange={(e) => onSeconds(c.id, e.target.value)}
                      />
                      秒
                    </>
                  )}
                </span>
              )
            })}
          </div>
        )}
        {row.issues.map((iss, i) => (
          <div className="pv-issue" key={i} data-testid={`pv-issue-${iss.kind}`} style={{ color: ISSUE_STYLE[iss.kind].color }}>
            <span className="pv-badge" style={{ borderColor: ISSUE_STYLE[iss.kind].color }}>
              {ISSUE_META.find((m) => m.kind === iss.kind)?.label}
            </span>
            {iss.reason}
            {iss.kind === 'seconds-nan' && (
              <span className="pv-fix">
                补成秒数：
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  defaultValue={2}
                  aria-label="补正秒数"
                  data-testid="pv-fix-seconds"
                />
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="pv-fix-adopt"
                  onClick={(e) => {
                    const input = e.currentTarget.parentElement?.querySelector('input')
                    if (input) onAdopt(iss, parseFloat(input.value))
                  }}
                >
                  识别为标记
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
