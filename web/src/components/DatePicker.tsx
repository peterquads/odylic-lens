import { useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'

interface DatePickerProps {
  start: string
  end: string
  compareStart?: string
  compareEnd?: string
  onApply: (start: string, end: string, compareStart?: string, compareEnd?: string) => void
  onClose: () => void
  /** Hide the compare-period UI entirely (e.g. Funnel Viewer). */
  hideCompare?: boolean
}

const PRESETS = [
  'Today', 'Yesterday', 'Last 7 days', 'Last 14 days', 'Last 28 days',
  'Last 30 days', 'This week', 'Last week', 'This month', 'Last month',
  'This quarter', 'Last quarter', 'This year',
]

const COMPARE_TYPES = ['Previous period', 'Previous month', 'Previous year', 'Custom']

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function fmt(d: Date) { return d.toISOString().split('T')[0] }
function fmtDisplay(s: string) {
  if (!s) return ''
  const d = new Date(s + 'T00:00:00')
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`
}

function getPresetRange(label: string): { start: string; end: string } | null {
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const y = today.getFullYear(), m = today.getMonth(), dow = today.getDay()
  switch (label) {
    case 'Today': return { start: fmt(today), end: fmt(today) }
    case 'Yesterday': return { start: fmt(yesterday), end: fmt(yesterday) }
    case 'Last 7 days': { const s = new Date(today); s.setDate(s.getDate() - 7); return { start: fmt(s), end: fmt(yesterday) } }
    case 'Last 14 days': { const s = new Date(today); s.setDate(s.getDate() - 14); return { start: fmt(s), end: fmt(yesterday) } }
    case 'Last 28 days': { const s = new Date(today); s.setDate(s.getDate() - 28); return { start: fmt(s), end: fmt(yesterday) } }
    case 'Last 30 days': { const s = new Date(today); s.setDate(s.getDate() - 30); return { start: fmt(s), end: fmt(yesterday) } }
    case 'This week': { const s = new Date(today); s.setDate(s.getDate() - dow); return { start: fmt(s), end: fmt(yesterday) } }
    case 'Last week': { const s = new Date(today); s.setDate(s.getDate() - dow - 7); const e = new Date(s); e.setDate(e.getDate() + 6); return { start: fmt(s), end: fmt(e) } }
    case 'This month': return { start: fmt(new Date(y, m, 1)), end: fmt(yesterday) }
    case 'Last month': return { start: fmt(new Date(y, m - 1, 1)), end: fmt(new Date(y, m, 0)) }
    case 'This quarter': return { start: fmt(new Date(y, Math.floor(m / 3) * 3, 1)), end: fmt(yesterday) }
    case 'Last quarter': return { start: fmt(new Date(y, Math.floor(m / 3) * 3 - 3, 1)), end: fmt(new Date(y, Math.floor(m / 3) * 3, 0)) }
    case 'This year': return { start: `${y}-01-01`, end: fmt(yesterday) }
    default: return null
  }
}

function getCompareRange(start: string, end: string, type: string): { start: string; end: string } {
  const s = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00')
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1

  if (type === 'Previous period') {
    const cs = new Date(s); cs.setDate(cs.getDate() - days)
    const ce = new Date(s); ce.setDate(ce.getDate() - 1)
    return { start: fmt(cs), end: fmt(ce) }
  }
  if (type === 'Previous month') {
    const cs = new Date(s.getFullYear(), s.getMonth() - 1, s.getDate())
    const ce = new Date(e.getFullYear(), e.getMonth() - 1, e.getDate())
    return { start: fmt(cs), end: fmt(ce) }
  }
  if (type === 'Previous year') {
    const cs = new Date(s.getFullYear() - 1, s.getMonth(), s.getDate())
    const ce = new Date(e.getFullYear() - 1, e.getMonth(), e.getDate())
    return { start: fmt(cs), end: fmt(ce) }
  }
  return { start: '', end: '' }
}

function MiniCal({ year, month, start, end, compareStart, compareEnd, onSelect, onNav, onSetMonth, onSetYear }: {
  year: number; month: number; start: string; end: string
  compareStart?: string; compareEnd?: string
  onSelect: (d: string) => void; onNav: (dir: number) => void
  onSetMonth: (m: number) => void; onSetYear: (y: number) => void
}) {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = fmt(new Date())
  const currYear = new Date().getFullYear()
  const years: number[] = []
  for (let y = 2020; y <= currYear + 1; y++) years.push(y)

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const selectCls = "text-xs font-medium bg-transparent hover:bg-black/[0.04] rounded px-1 py-0.5 cursor-pointer outline-none"

  return (
    <div style={{ width: 196 }}>
      <div className="flex items-center justify-between mb-1.5">
        <button onClick={() => onNav(-1)} className="p-0.5 hover:bg-black/[0.04] rounded"><ChevronLeft size={12} /></button>
        <div className="flex items-center gap-0.5">
          <select value={month} onChange={e => onSetMonth(parseInt(e.target.value))} className={selectCls}>
            {MONTHS.map((m, i) => <option key={i} value={i}>{m.slice(0, 3)}</option>)}
          </select>
          <select value={year} onChange={e => onSetYear(parseInt(e.target.value))} className={selectCls}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button onClick={() => onNav(1)} className="p-0.5 hover:bg-black/[0.04] rounded"><ChevronRight size={12} /></button>
      </div>
      <div className="grid grid-cols-7">
        {DAYS_SHORT.map((d, i) => <div key={i} className="text-[9px] text-center text-text-muted py-0.5">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} className="w-7 h-6" />
          const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const isStart = ds === start, isEnd = ds === end
          const inRange = start && end && ds >= start && ds <= end
          const inCompare = compareStart && compareEnd && ds >= compareStart && ds <= compareEnd

          let bg = ''
          let inlineStyle: React.CSSProperties | undefined
          if (isStart || isEnd) {
            bg = 'text-white font-medium'
            inlineStyle = { background: '#B7410E', boxShadow: '0 1px 2px rgba(183,65,14,0.35)' }
          } else if (inRange) {
            inlineStyle = { background: 'rgba(183,65,14,0.12)', color: '#9a4912' }
          } else if (inCompare) {
            bg = 'text-gray-700'
            inlineStyle = { background: 'rgba(0,0,0,0.06)' }
          }

          return (
            <button key={day} onClick={() => onSelect(ds)}
              style={inlineStyle}
              className={`w-7 h-6 text-[11px] rounded transition-colors ${bg || 'hover:bg-black/[0.04]'} ${ds === today && !bg ? 'font-bold' : ''}`}>
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DatePicker({ start, end, compareStart, compareEnd, onApply, onClose, hideCompare }: DatePickerProps) {
  const [tempStart, setTempStart] = useState(start)
  const [tempEnd, setTempEnd] = useState(end)
  const [picking, setPicking] = useState<'start' | 'end'>('start')
  // Initialize compare state from app props so reopening reflects reality
  const [compareOn, setCompareOn] = useState(!!(compareStart && compareEnd))
  const [compareType, setCompareType] = useState('Previous period')
  const [compareDropOpen, setCompareDropOpen] = useState(false)
  const [customCompStart, setCustomCompStart] = useState(compareStart || '')
  const [customCompEnd, setCustomCompEnd] = useState(compareEnd || '')
  const [activePreset, setActivePreset] = useState<string | null>(null)

  const ed = new Date((tempEnd || tempStart || end) + 'T00:00:00')
  const [rightMonth, setRightMonth] = useState(ed.getMonth())
  const [rightYear, setRightYear] = useState(ed.getFullYear())

  const leftMonth = rightMonth === 0 ? 11 : rightMonth - 1
  const leftYear = rightMonth === 0 ? rightYear - 1 : rightYear

  const compRange = compareType === 'Custom'
    ? { start: customCompStart, end: customCompEnd }
    : getCompareRange(tempStart, tempEnd, compareType)

  function nav(dir: number) {
    let m = rightMonth + dir, y = rightYear
    if (m > 11) { m = 0; y++ }
    if (m < 0) { m = 11; y-- }
    setRightMonth(m); setRightYear(y)
  }

  function selectDate(ds: string) {
    if (picking === 'start') {
      setTempStart(ds)
      setPicking('end')
      if (ds > tempEnd) setTempEnd(ds)
    } else {
      if (ds < tempStart) { setTempStart(ds) } else { setTempEnd(ds) }
      setPicking('start')
    }
    setActivePreset(null)
  }

  function selectPreset(label: string) {
    const r = getPresetRange(label)
    if (r) {
      setTempStart(r.start); setTempEnd(r.end); setActivePreset(label)
      const d = new Date(r.end + 'T00:00:00')
      setRightMonth(d.getMonth()); setRightYear(d.getFullYear())
    }
  }

  return (
    <div className="fixed inset-0" style={{ zIndex: 99998, background: 'rgba(20,20,20,0.18)' }} onClick={onClose}>
      <div className="fixed rounded-2xl"
        style={{
          zIndex: 99999, top: '60px', left: '50%', transform: 'translateX(-50%)', width: 580,
          background: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.55)',
          boxShadow: '0 24px 60px -16px rgba(0,0,0,0.22), inset 0 1px 0 0 rgba(255,255,255,0.7)',
        }}
        onClick={e => e.stopPropagation()}>
        <div className="flex">
          {/* Presets */}
          <div className="w-[140px] border-r border-black/[0.06] py-2 px-2 flex-shrink-0 flex flex-col gap-0.5" style={{ maxHeight: 380, overflowY: 'auto' }}>
            {PRESETS.map(p => {
              const isActive = activePreset === p
              return (
                <button key={p} onClick={() => selectPreset(p)}
                  className="px-2.5 py-1 text-[11px] text-left flex items-center gap-1.5 rounded-full transition-colors h-7"
                  style={isActive
                    ? { background: 'rgba(183,65,14,0.10)', border: '1px solid rgba(183,65,14,0.30)', color: '#b55719' }
                    : { background: 'transparent', border: '1px solid transparent', color: '#6b7280' }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(0,0,0,0.04)' }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
                  {p}
                </button>
              )
            })}
          </div>

          {/* Right side */}
          <div className="flex-1 p-3">
            {/* Calendars */}
            <div className="flex gap-4 justify-center mb-3">
              <MiniCal year={leftYear} month={leftMonth} start={tempStart} end={tempEnd}
                compareStart={compareOn ? compRange.start : undefined} compareEnd={compareOn ? compRange.end : undefined}
                onSelect={selectDate} onNav={nav}
                onSetMonth={m => {
                  // Picking left calendar's month shifts right calendar one month ahead.
                  const newRight = m + 1
                  if (newRight > 11) { setRightMonth(0); setRightYear(leftYear + 1) }
                  else { setRightMonth(newRight); setRightYear(leftYear) }
                }}
                onSetYear={y => {
                  const newRight = leftMonth + 1
                  if (newRight > 11) { setRightMonth(0); setRightYear(y + 1) }
                  else { setRightMonth(newRight); setRightYear(y) }
                }} />
              <MiniCal year={rightYear} month={rightMonth} start={tempStart} end={tempEnd}
                compareStart={compareOn ? compRange.start : undefined} compareEnd={compareOn ? compRange.end : undefined}
                onSelect={selectDate} onNav={nav}
                onSetMonth={m => setRightMonth(m)}
                onSetYear={y => setRightYear(y)} />
            </div>

            {/* Compare section */}
            {!hideCompare && (
            <div className="border-t border-black/[0.06] pt-2.5">
              <label className="inline-flex items-center gap-1.5 mb-2 cursor-pointer h-7 px-2.5 rounded-full text-[11px] transition-colors"
                style={compareOn
                  ? { background: 'rgba(183,65,14,0.10)', border: '1px solid rgba(183,65,14,0.30)', color: '#b55719' }
                  : { background: 'transparent', border: '1px solid rgba(0,0,0,0.10)', color: '#6b7280' }}>
                <span
                  className="w-3.5 h-3.5 rounded flex items-center justify-center transition-colors"
                  style={compareOn
                    ? { background: '#B7410E', boxShadow: 'inset 0 0 0 1px rgba(183,65,14,0.4)' }
                    : { background: 'rgba(0,0,0,0.04)', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}>
                  {compareOn && (
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 8.5 6.5 12 13 5" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <input type="checkbox" checked={compareOn} onChange={e => setCompareOn(e.target.checked)}
                  className="sr-only" />
                <span className="font-medium">Compare</span>
              </label>

              {compareOn && (
                <div className="space-y-1.5">
                  {/* Main period row */}
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#B7410E' }} />
                    <span className="text-[11px] text-text-muted w-[80px]">{activePreset || 'Custom'}</span>
                    <input type="date" value={tempStart} onChange={e => { setTempStart(e.target.value); setActivePreset(null) }}
                      className="text-[11px] border border-black/[0.08] rounded px-1.5 py-1 w-[120px]" />
                    <span className="text-text-muted text-[10px]">–</span>
                    <input type="date" value={tempEnd} onChange={e => { setTempEnd(e.target.value); setActivePreset(null) }}
                      className="text-[11px] border border-black/[0.08] rounded px-1.5 py-1 w-[120px]" />
                  </div>

                  {/* Compare period row */}
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
                    <div className="relative w-[120px]">
                      <button onClick={() => setCompareDropOpen(!compareDropOpen)}
                        className="text-[11px] rounded-full px-2.5 py-1 w-full text-left flex items-center justify-between transition-colors h-7"
                        style={{
                          background: 'rgba(183,65,14,0.10)',
                          border: '1px solid rgba(183,65,14,0.30)',
                          color: '#b55719',
                        }}>
                        <span className="truncate">{compareType.replace('Previous ', 'Prev ')}</span>
                        <ChevronDown size={9} />
                      </button>
                      {compareDropOpen && (
                        <div className="absolute top-full left-0 mt-1 rounded-lg shadow-xl py-1 w-[160px]"
                          style={{
                            zIndex: 100000,
                            background: 'rgba(255,255,255,0.85)',
                            backdropFilter: 'blur(30px) saturate(180%)',
                            WebkitBackdropFilter: 'blur(30px) saturate(180%)',
                            border: '1px solid rgba(255,255,255,0.55)',
                          }}>
                          {COMPARE_TYPES.map(t => (
                            <button key={t} onClick={() => { setCompareType(t); setCompareDropOpen(false) }}
                              className="w-full px-3 py-1.5 text-[11px] text-left flex items-center gap-2 hover:bg-black/[0.04] transition-colors"
                              style={compareType === t ? { color: '#B7410E' } : { color: 'var(--text-secondary, #4b5563)' }}>
                              <span
                                className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0"
                                style={compareType === t
                                  ? { borderColor: '#B7410E', background: '#B7410E' }
                                  : { borderColor: 'rgba(0,0,0,0.18)' }} />
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {compareType === 'Custom' ? (
                      <>
                        <input type="date" value={customCompStart} onChange={e => setCustomCompStart(e.target.value)}
                          className="text-[11px] border border-black/[0.08] rounded px-1.5 py-1 w-[120px]" />
                        <span className="text-text-muted text-[10px]">–</span>
                        <input type="date" value={customCompEnd} onChange={e => setCustomCompEnd(e.target.value)}
                          className="text-[11px] border border-black/[0.08] rounded px-1.5 py-1 w-[120px]" />
                      </>
                    ) : (
                      <span className="text-[11px] text-text-muted">
                        {fmtDisplay(compRange.start)} – {fmtDisplay(compRange.end)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-black/[0.06]">
              <span className="text-[10px] text-text-muted">
                {fmtDisplay(tempStart)} – {fmtDisplay(tempEnd)}
              </span>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 h-7 text-[11px] text-text-secondary rounded-full transition-colors hover:bg-black/[0.04]"
                  style={{ border: '1px solid rgba(0,0,0,0.10)' }}>
                  Cancel
                </button>
                <button onClick={() => {
                    onApply(tempStart, tempEnd, compareOn ? compRange.start : undefined, compareOn ? compRange.end : undefined)
                    onClose()
                  }}
                  className="px-3.5 h-7 text-[11px] rounded-full font-medium transition-colors"
                  style={{
                    background: 'rgba(183,65,14,0.10)',
                    border: '1px solid rgba(183,65,14,0.30)',
                    color: '#b55719',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(183,65,14,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(183,65,14,0.10)')}>
                  Update
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
