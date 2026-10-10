import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { toolColor } from '../charts/palette'

/**
 * The top of a card: an icon tile tinted with the tool's own colour, a title, one line saying what
 * the card is for, and room on the right for what you do here.
 */
export function CardHead({ icon: Icon, tool, title, sub, children }: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
  tool?: string
  title: string
  sub?: string
  children?: ReactNode
}) {
  return (
    <div className="card-head">
      <div className="card-title">
        {Icon && (
          <span className="navtile" style={tool ? ({ '--tile': toolColor(tool) } as CSSProperties) : undefined}>
            <Icon size={17} strokeWidth={2} aria-hidden />
          </span>
        )}
        <div>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </div>
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  )
}
