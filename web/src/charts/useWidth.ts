import { useEffect, useRef, useState } from 'react'

/** The width of an element, kept current as it resizes, so a chart is drawn at the size it has. */
export function useWidth<T extends HTMLElement>(initial = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(Math.round(el.getBoundingClientRect().width) || initial)
    const watch = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width) || initial)
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [initial])
  return [ref, width]
}

/** A number that counts up to its value. Instant for people who asked for less motion. */
export function useCountUp(value: number, ms = 700): number {
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || ms <= 0) { setShown(value); from.current = value; return }
    const start = performance.now()
    const begin = from.current
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = 1 - (1 - t) ** 3
      setShown(begin + (value - begin) * eased)
      if (t < 1) frame = requestAnimationFrame(tick)
      else from.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, ms])
  return shown
}
