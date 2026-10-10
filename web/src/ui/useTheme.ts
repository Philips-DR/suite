// Light, dark, or follow the system. The choice is a convenience, kept in this browser only:
// storage can be blocked (a private window), and then it simply is not remembered.

import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'assistant-theme'

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  // The browser's own chrome (the address bar on a phone) follows the page.
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0f15' : '#f3f5f9')
}

export function useTheme(): [ThemeChoice, () => void, (to: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored)

  useEffect(() => {
    applyTheme(choice)
    if (choice !== 'system') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const follow = () => applyTheme('system')
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [choice])

  const set = useCallback((to: ThemeChoice) => {
    setChoice(to)
    try {
      if (to === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, to)
    } catch {
      // not remembered; still applied
    }
  }, [])

  const cycle = useCallback(() => set(choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system'), [choice, set])
  return [choice, cycle, set]
}
