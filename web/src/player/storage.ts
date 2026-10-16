// What the player remembers (where you stopped in each file, the speed, the volume) lives in this
// browser only. Storage can be blocked or full, so nothing here may throw: a failure is "not remembered".

export const store = {
  read(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  write(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* not remembered */ }
  },
}

export function numeric(key: string, fallback: number): number {
  const raw = store.read(key)
  if (raw === null) return fallback
  const v = Number(raw)
  return Number.isFinite(v) ? v : fallback
}
