import { useMemo, useRef, useState } from 'react'
import {
  PREVIEW_ISSUE_META,
  previewScriptText,
  type PreviewIssueType,
} from '../engine/parse'
import { HOLDABLE_KINDS, KIND_LABELS } from '../constants'
import type { Line, Segment } from '../types'

export type PasteMode = 'replace' | 'append'

interface PastePreviewProps {
  raw: string
  autoBlank: boolean
  initialMode: PasteMode
  /** 现有文稿的段数，用于追加落位提示 */
  existingSegmentCount: number
  existingLineCount: number
  lastSegmentTitle?: string
  onClose: () => void
  /** 确认才提交，提交的行/段使用预览生成的 id（此时尚未写入任何文稿） */
  onCommit: (mode: PasteMode, lines: Line[], segments: Segment[]) => void
}

const ISSUE_CLASS: Record<PreviewIssueType, string> = {
  longRole: 'pv-tag-long',
  unbalancedBrackets: 'pv-tag-bracket',
  zeroSeconds: 'pv-tag-zero',
  badSeconds: 'pv-tag-badnum',
}

export function PastePreview({
  raw,
  autoBlank,
  initialMode,
  existingSegmentCount,
  existingLineCount,
  lastSegmentTitle,
  onClose,
  onCommit,
}: PastePreviewProps) {
  const pv = useMemo(() => previewScriptText(raw, { autoSegmentOnBlank: autoBlank }), [raw, autoBlank])
  const [mode, setMode] = useState<PasteMode>(initialMode)
  const [filter, setFilter] = useState<PreviewIssueType | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)

  const [roles, setRoles] = useState<Record<string, string>>(() =>
    Object.fromEntries(pv.lines.map((pl) => [pl.line.id, pl.line.role ?? ''])),
  )
  const [seconds, setSeconds] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const pl of pv.lines) {
      for (const c of pl.line.cues) {
        if (HOLDABLE_KINDS.includes(c.kind)) map[c.id] = String(c.seconds ?? '')
      }
    }
    return map
  })

  const issueRows = pv.lines.filter((pl) => pl.issues.some((i) => !filter || i.type === filter))

  const jumpToLine = (lineId: string) => {
    const el = document.getElementById(`pv-line-${lineId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashId(lineId)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1600)
  }

  const secValueValid = (cueId: string) => {
    const v = Number(seconds[cueId])
    return Number.isFinite(v) && v > 0
  }

  const finalize = (): { lines: Line[]; segments: Segment[] } => {
    const lines = pv.lines.map((pl) => ({
      ...pl.line,
      role: roles[pl.line.id].trim() || undefined,
      cues: pl.line.cues.map((c) => {
        if (!HOLDABLE_KINDS.includes(c.kind)) return c
        const v = Number(seconds[c.id])
        return { ...c, seconds: Number.isFinite(v) && v > 0 ? v : (c.seconds ?? 0) }
      }),
    }))
    const segments: Segment[] = pv.segments.map((s) => ({
      id: s.id,
      title: s.title,
      lineIds: s.lineIds,
    }))
    return { lines, segments }
  }

  return (
    <section className="panel paste-preview" data-testid="paste-preview">
      <div className="pv-head">
        <h2>导入预览</h2>
        <div className="pv-modes" role="tablist">
          <button
            className={`pv-mode${mode === 'replace' ? ' on' : ''}`}
            data-testid="preview-mode-replace"
            onClick={() => setMode('replace')}
          >替换全篇</button>
          <button
            className={`pv-mode${mode === 'append' ? ' on' : ''}`}
            data-testid="preview-mode-append"
            onClick={() => setMode('append')}
          >追加到末尾</button>
        </div>
        <button className="op" title="关闭预览（不写入）" onClick={onClose}>✕</button>
      </div>

      <div
        className={`pv-banner ${mode === 'replace' ? 'pv-banner-replace' : 'pv-banner-append'}`}
        data-testid={mode === 'replace' ? 'replace-banner' : 'append-banner'}
      >
        {mode === 'replace' ? (
          existingSegmentCount > 0 || existingLineCount > 0 ? (
            <>将以预览中的 <b>{pv.segmentCount} 段、{pv.lineCount} 句</b> 替换现有文稿
            （现有 {existingSegmentCount} 段、{existingLineCount} 句会被移除）。确认前不会改动现有文稿。</>
          ) : (
            <>将写入 <b>{pv.segmentCount} 段、{pv.lineCount} 句</b>。现有文稿为空，确认前不会写入任何内容。</>
          )
        ) : (
          <>将<b>追加</b> {pv.segmentCount} 段、{pv.lineCount} 句到末尾
          {existingSegmentCount > 0 && lastSegmentTitle
            ? <>，新段落会接在现有末段「{lastSegmentTitle}」（第 {existingSegmentCount} 段）后面</>
            : null}，不改动已有句子。确认前不会写入任何内容。</>
        )}
      </div>

      <div className="pv-summary" data-testid="preview-summary">
        <span className="pv-stat">共 <b data-testid="preview-seg-count">{pv.segmentCount}</b> 段</span>
        <span className="pv-stat"><b data-testid="preview-line-count">{pv.lineCount}</b> 句</span>
        {pv.issueCount === 0 ? (
          <span className="ok">全部行均可正常识别</span>
        ) : (
          <span className="pv-issue-chips">
            {PREVIEW_ISSUE_META.map((m) => (
              <button
                key={m.type}
                className={`pv-issue-chip ${ISSUE_CLASS[m.type]}${filter === m.type ? ' on' : ''}`}
                data-testid={`preview-filter-${m.type}`}
                data-count={pv.counts[m.type]}
                disabled={pv.counts[m.type] === 0}
                onClick={() => setFilter((f) => (f === m.type ? null : m.type))}
              >{m.label} {pv.counts[m.type]}</button>
            ))}
            <span className="muted">{pv.issueLineCount} 行有待处理提示</span>
            {filter && (
              <button className="pv-clear-filter" onClick={() => setFilter(null)}>清除筛选（{PREVIEW_ISSUE_META.find((m) => m.type === filter)?.label}）</button>
            )}
          </span>
        )}
      </div>

      {issueRows.length > 0 && (
        <div className="pv-issues" data-testid="preview-issue-list">
          {issueRows.map((pl) =>
            pl.issues
              .filter((i) => !filter || i.type === filter)
              .map((iss) => (
                <button
                  key={`${pl.line.id}-${iss.type}-${iss.cueId ?? ''}`}
                  className={`pv-issue-row ${ISSUE_CLASS[iss.type]}`}
                  data-testid={`preview-issue-${iss.type}`}
                  onClick={() => jumpToLine(pl.line.id)}
                >
                  <span className="pv-issue-no">第 {pl.globalNo} 行</span>
                  <span className="pv-issue-tag">{PREVIEW_ISSUE_META.find((m) => m.type === iss.type)?.label}</span>
                  <span className="pv-issue-reason">{iss.reason}</span>
                </button>
              )),
          )}
        </div>
      )}

      <div className="pv-segments" data-testid="preview-segments">
        {pv.segments.map((seg) => (
          <div className="pv-seg" key={seg.id} data-testid="preview-segment">
            <div className="pv-seg-head">
              <span className="pv-seg-title">
                {mode === 'append' && existingSegmentCount > 0
                  ? `追加后第 ${existingSegmentCount + seg.index + 1} 段 · `
                  : `第 ${seg.index + 1} 段 · `}
                {seg.title}
              </span>
              <span className="muted">{seg.lineIds.length} 句</span>
              {mode === 'append' && seg.index === 0 && existingSegmentCount > 0 && (
                <span className="pv-anchor">↑ 接在「{lastSegmentTitle}」之后</span>
              )}
              {seg.empty && <span className="pv-anchor pv-anchor-empty">空段（无句子）</span>}
            </div>
            {seg.empty && <div className="muted pv-empty-note">该段没有可写入的句子（原文此处只有段头或空行）。</div>}
            {pv.lines
              .filter((pl) => pl.segId === seg.id)
              .map((pl) => {
                const hasLongRole = pl.issues.some((i) => i.type === 'longRole')
                return (
                  <div
                    key={pl.line.id}
                    id={`pv-line-${pl.line.id}`}
                    className={`pv-line${flashId === pl.line.id ? ' flash' : ''}${pl.issues.length ? ' has-issue' : ''}`}
                    data-testid="preview-line"
                    data-no={pl.globalNo}
                  >
                    <span className="line-no">{pl.globalNo}</span>
                    <input
                      className={`line-role pv-input${hasLongRole ? ' pv-input-warn' : ''}`}
                      data-testid="preview-line-role"
                      placeholder="角色"
                      value={roles[pl.line.id]}
                      onChange={(e) => setRoles((r) => ({ ...r, [pl.line.id]: e.target.value }))}
                    />
                    <span className="pv-text">{pl.line.text || <span className="muted">（无唱词，仅标记行）</span>}</span>
                    <div className="line-cues">
                      {pl.line.cues.map((c) => (
                        <span className="cue-chip" key={c.id} data-kind={c.kind} data-testid="preview-cue-chip">
                          {KIND_LABELS[c.kind]}
                          {HOLDABLE_KINDS.includes(c.kind) && (
                            <input
                              type="number"
                              min={0.5}
                              step={0.5}
                              className={`pv-sec${!secValueValid(c.id) ? ' pv-input-warn' : ''}`}
                              data-testid="preview-cue-seconds"
                              data-kind={c.kind}
                              aria-label={`${KIND_LABELS[c.kind]}秒数`}
                              value={seconds[c.id] ?? ''}
                              onChange={(e) => setSeconds((s) => ({ ...s, [c.id]: e.target.value }))}
                            />
                          )}
                          <span className="pv-sec-unit">秒</span>
                          {c.kind === 'note' && c.label ? <span className="pv-note-label">{c.label}</span> : null}
                        </span>
                      ))}
                      {pl.line.cues.length === 0 && <span className="muted pv-no-cue">无停留标记</span>}
                    </div>
                    {pl.issues.length > 0 && (
                      <div className="pv-line-tags">
                        {pl.issues.map((iss) => (
                          <button
                            key={`${iss.type}-${iss.cueId ?? ''}`}
                            className={`pv-tag ${ISSUE_CLASS[iss.type]}`}
                            title={iss.reason}
                            onClick={() => setFilter(iss.type)}
                          >{PREVIEW_ISSUE_META.find((m) => m.type === iss.type)?.label}</button>
                        ))}
                      </div>
                    )}
                    <div className="pv-raw" data-testid="preview-raw">原文：{pl.raw}</div>
                  </div>
                )
              })}
          </div>
        ))}
      </div>

      <div className="pv-foot">
        <button className="btn btn-ghost" data-testid="btn-preview-cancel" onClick={onClose}>取消（不写入）</button>
        <button
          className="btn"
          data-testid="btn-preview-confirm"
          disabled={pv.lineCount === 0}
          onClick={() => {
            const { lines, segments } = finalize()
            onCommit(mode, lines, segments)
          }}
        >
          {pv.lineCount === 0
            ? '没有可写入的句子'
            : mode === 'replace'
              ? `确认写入：替换全篇（${pv.lineCount} 句）`
              : `确认写入：追加到末尾（${pv.lineCount} 句）`}
        </button>
      </div>
    </section>
  )
}
