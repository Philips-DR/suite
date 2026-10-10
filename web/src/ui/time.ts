/** "just now", "5 min ago", "3 h ago", "2 d ago": how long ago, the way a person says it. */
export function ago(when: Date | string | number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(when).getTime()) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export const clock = (seconds: number | null | undefined): string => {
  const s = Math.max(0, Math.floor(seconds ?? 0))
  const pad = (n: number) => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
