import type { ReactNode } from 'react'
import { sectionById, type Section } from './sections'

/** The heading of a page: its name, one line on what it is for, and room for what you do here. */
export function PageHead({ section, blurb, children }: { section: Section; blurb?: string; children?: ReactNode }) {
  const info = sectionById(section)
  return (
    <header className="pagehead">
      <div>
        <h1>{info.title}</h1>
        <p className="pagehead-blurb">{blurb ?? info.blurb}</p>
      </div>
      {children && <div className="pagehead-actions">{children}</div>}
    </header>
  )
}
