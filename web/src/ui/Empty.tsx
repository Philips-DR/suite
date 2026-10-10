import type { ComponentType, ReactNode } from 'react'

/** What a place says when it has nothing yet: what will appear here, and how to make it. */
export function Empty({ icon: Icon, title, children, action }: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      {Icon && <span className="empty-icon"><Icon size={22} strokeWidth={1.8} aria-hidden /></span>}
      <strong>{title}</strong>
      {children && <span className="empty-text">{children}</span>}
      {action}
    </div>
  )
}
