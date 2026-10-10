// Ctrl+K: jump anywhere, or switch theme, without leaving the keyboard. Navigation only; nothing
// here runs a tool, so opening it can never change anything.

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { IconMoon, IconSearch, IconSun, IconSystem } from './icons'
import { SECTIONS, type Section } from './sections'
import type { ThemeChoice } from './useTheme'

interface Item {
  id: string
  label: string
  hint: string
  icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
  keywords: string
  run: () => void
}

export function CommandPalette({ open, onClose, go, setTheme, pending }: {
  open: boolean
  onClose: () => void
  go: (to: Section) => void
  setTheme: (to: ThemeChoice) => void
  pending: number
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const items = useMemo<Item[]>(() => [
    ...SECTIONS.map((s) => ({
      id: s.id, label: s.label, hint: s.blurb, icon: s.icon, keywords: `${s.keywords} go open`,
      run: () => go(s.id),
    })),
    { id: 'theme-light', label: 'Light theme', hint: 'Always light', icon: IconSun, keywords: 'theme appearance bright', run: () => setTheme('light') },
    { id: 'theme-dark', label: 'Dark theme', hint: 'Always dark', icon: IconMoon, keywords: 'theme appearance night', run: () => setTheme('dark') },
    { id: 'theme-system', label: 'Match system theme', hint: 'Follow the device', icon: IconSystem, keywords: 'theme appearance auto', run: () => setTheme('system') },
  ], [go, setTheme])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((i) => `${i.label} ${i.keywords}`.toLowerCase().includes(needle))
  }, [items, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      window.setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])
  useEffect(() => setActive(0), [query])

  if (!open) return null

  const choose = (item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]) }
  }

  return (
    <div className="palette-root" role="dialog" aria-modal="true" aria-label="Jump to" onKeyDown={onKey}>
      <div className="palette-backdrop" onClick={onClose} />
      <div className="palette">
        <div className="palette-input">
          <IconSearch size={18} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page, or change the theme"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `palette-${shown[active]!.id}` : undefined}
            aria-label="Jump to"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" className="palette-list" role="listbox">
          {shown.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
          {shown.map((item, i) => {
            const Icon = item.icon
            return (
              <li key={item.id} id={`palette-${item.id}`} role="option" aria-selected={i === active}
                className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
                <Icon size={18} strokeWidth={2} aria-hidden />
                <span className="palette-label">{item.label}</span>
                <span className="palette-hint muted small">{item.hint}</span>
                {item.id === 'chat' && pending > 0 && <span className="navbadge">{pending}</span>}
              </li>
            )
          })}
        </ul>
        <div className="palette-foot muted small">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
        </div>
      </div>
    </div>
  )
}
