// The frame around every page: a sidebar on a desktop, a slim rail on a tablet, a top bar and a
// bottom tab bar on a phone. All of it reads sections.ts, so adding a page is one entry there.

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '../state'
import { toolColor } from '../charts/palette'
import { IconClose, IconCommand, IconMoon, IconMore, IconSearch, IconSun, IconSystem } from './icons'
import { SECTIONS, TAB_SECTIONS, sectionById, type Section } from './sections'
import type { ThemeChoice } from './useTheme'

/** "us.anthropic.claude-opus-4-6-v1" -> "Opus 4.6". The full id is the tooltip. */
export function modelName(id: string): string {
  const match = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}` : id || 'Assistant'
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brandmark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <circle cx="16" cy="16" r="8.6" fill="none" stroke="var(--brand-ink)" strokeWidth="2.2" opacity="0.9" />
      <circle cx="16" cy="16" r="3.4" fill="var(--brand-ink)" />
      <circle cx="23.2" cy="9.6" r="2" fill="var(--brand-ink)" opacity="0.9" />
    </svg>
  )
}

export function ConnectionPill() {
  const { connected, busy, model } = useAppState()
  const state = !connected ? 'down' : busy ? 'busy' : 'up'
  return (
    <div className={`conn-pill ${state}`} title={model || undefined}>
      <span className="conn-dot" aria-hidden />
      <span className="conn-text">
        {state === 'down' ? 'Reconnecting…' : state === 'busy' ? 'Working…' : modelName(model)}
      </span>
    </div>
  )
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof IconSun }[] = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'system', label: 'Match system', icon: IconSystem },
  { value: 'dark', label: 'Dark', icon: IconMoon },
]

export function ThemeSwitch({ choice, onChoose }: { choice: ThemeChoice; onChoose: (to: ThemeChoice) => void }) {
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={choice === value}
          aria-label={label}
          title={label}
          className={choice === value ? 'on' : ''}
          onClick={() => onChoose(value)}
        >
          <Icon size={15} strokeWidth={2} aria-hidden />
        </button>
      ))}
    </div>
  )
}

export function Sidebar({ section, go, theme, setTheme, openPalette }: {
  section: Section
  go: (to: Section) => void
  theme: ThemeChoice
  setTheme: (to: ThemeChoice) => void
  openPalette: () => void
}) {
  const { pending } = useAppState()
  const groups = ['Workspace', 'Tools', 'System'] as const
  return (
    <aside className="sidenav" aria-label="Sections">
      <a className="brand" href="#overview" onClick={(e) => { e.preventDefault(); go('overview') }}>
        <BrandMark />
        <span className="brand-word">Assistant</span>
      </a>

      <nav className="navgroups">
        {groups.map((group) => (
          <div key={group} className="navgroup">
            <span className="navgroup-label">{group}</span>
            {SECTIONS.filter((s) => s.group === group).map((s) => {
              const Icon = s.icon
              const badge = s.id === 'chat' && pending.length > 0 ? pending.length : 0
              return (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="navitem"
                  aria-current={section === s.id ? 'page' : undefined}
                  title={s.label}
                  onClick={(e) => { e.preventDefault(); go(s.id) }}
                >
                  <span className="navtile" style={s.tool ? ({ '--tile': toolColor(s.tool) } as React.CSSProperties) : undefined}>
                    <Icon size={17} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="navlabel">{s.label}</span>
                  {badge > 0 && <span className="navbadge" aria-label={`${badge} waiting for approval`}>{badge}</span>}
                </a>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="sidefoot">
        <button className="palette-hint" onClick={openPalette} aria-label="Search and jump (Ctrl K)">
          <IconSearch size={15} aria-hidden />
          <span>Jump to…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <ConnectionPill />
        <ThemeSwitch choice={theme} onChoose={setTheme} />
      </div>
    </aside>
  )
}

export function TopBar({ section, openPalette, cycleTheme, theme }: {
  section: Section
  openPalette: () => void
  cycleTheme: () => void
  theme: ThemeChoice
}) {
  const info = sectionById(section)
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconSystem
  return (
    <header className="topbar">
      <BrandMark size={28} />
      <span className="topbar-title">{info.title}</span>
      <ConnectionPill />
      <button className="ghost icon" onClick={openPalette} aria-label="Search and jump"><IconSearch size={18} aria-hidden /></button>
      <button className="ghost icon" onClick={cycleTheme} aria-label={`Theme: ${theme}. Tap to change`}><ThemeIcon size={18} aria-hidden /></button>
    </header>
  )
}

export function TabBar({ section, go, openMore }: { section: Section; go: (to: Section) => void; openMore: () => void }) {
  const { pending } = useAppState()
  const inTabs = TAB_SECTIONS.includes(section)
  return (
    <nav className="tabbar" aria-label="Sections">
      {TAB_SECTIONS.map((id) => {
        const s = sectionById(id)
        const Icon = s.icon
        const badge = id === 'chat' && pending.length > 0 ? pending.length : 0
        return (
          <a key={id} href={`#${id}`} className="tab" aria-current={section === id ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); go(id) }}>
            <span className="tab-icon"><Icon size={21} strokeWidth={2} aria-hidden />{badge > 0 && <span className="navbadge">{badge}</span>}</span>
            <span className="tab-label">{s.label}</span>
          </a>
        )
      })}
      <button className="tab" aria-current={!inTabs ? 'page' : undefined} onClick={openMore} aria-haspopup="dialog">
        <span className="tab-icon"><IconMore size={21} strokeWidth={2} aria-hidden /></span>
        <span className="tab-label">More</span>
      </button>
    </nav>
  )
}

/** Everything that does not fit in the tab bar, as a sheet that slides up from it. */
export function MoreSheet({ open, onClose, section, go, theme, setTheme, onSearch }: {
  open: boolean
  onClose: () => void
  onSearch: () => void
  section: Section
  go: (to: Section) => void
  theme: ThemeChoice
  setTheme: (to: ThemeChoice) => void
}) {
  const first = useRef<HTMLAnchorElement>(null)
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      first.current?.focus()
    } else {
      const t = window.setTimeout(() => setMounted(false), 260) // let the slide-out finish
      return () => window.clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!mounted) return null
  const rest = SECTIONS.filter((s) => !TAB_SECTIONS.includes(s.id))
  return (
    <div className={`sheet-root ${open ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="More">
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h2>More</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><IconClose size={18} aria-hidden /></button>
        </div>
        <div className="sheet-grid">
          {rest.map((s, i) => {
            const Icon = s.icon
            return (
              <a key={s.id} ref={i === 0 ? first : undefined} href={`#${s.id}`} className="sheet-item"
                aria-current={section === s.id ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); onClose(); go(s.id) }}>
                <span className="navtile" style={s.tool ? ({ '--tile': toolColor(s.tool) } as React.CSSProperties) : undefined}>
                  <Icon size={20} strokeWidth={2} aria-hidden />
                </span>
                <span>{s.label}</span>
              </a>
            )
          })}
          <button className="sheet-item" onClick={() => { onClose(); onSearch() }}>
            <span className="navtile"><IconSearch size={20} strokeWidth={2} aria-hidden /></span>
            <span>Search</span>
          </button>
        </div>
        <div className="sheet-foot">
          <span className="muted small">Theme</span>
          <ThemeSwitch choice={theme} onChoose={setTheme} />
        </div>
      </div>
    </div>
  )
}

export { IconCommand }
