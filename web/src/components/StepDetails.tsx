// A tool call shown to a person: what it was asked as labelled fields, and what came back. The approval card shows
// the fields of a call waiting on you; Chat shows each reply's calls as one line that opens to the list.

import type { CSSProperties } from 'react'
import { isTool, toolColor, toolName, toolOf } from '../charts/palette'
import { IconCheck, IconClose } from '../ui/icons'
import { TOOL_ICON } from '../ui/toolMeta'
import { fieldsOf, resultText, stepTitle, stepsSummary, stepsTrouble, type Step } from './toolSteps'
import '../styles/panels/steps.css'

/** Label and value, each value whole and wrapped: an email's body reads as written, never as one long code line. */
export function Fields({ fields }: { fields: [string, string][] }) {
  return (
    <dl className="fields">
      {fields.map(([label, value], i) => (
        <div key={i} className="field">
          <dt>{label}</dt>
          {/* A long value scrolls in its own box, so it can be reached and scrolled from the keyboard too. */}
          {value.length > 160 || value.includes('\n')
            ? <dd className="long" tabIndex={0} aria-label={label}>{value}</dd>
            : <dd>{value}</dd>}
        </div>
      ))}
    </dl>
  )
}

function ToolTile({ tool, size = 14 }: { tool: string; size?: number }) {
  const Icon = isTool(tool) ? TOOL_ICON[tool] : null
  return (
    <span className="navtile step-tile" style={{ '--tile': toolColor(tool) } as CSSProperties} aria-hidden>
      {Icon && <Icon size={size} strokeWidth={2} aria-hidden />}
    </span>
  )
}

function Outcome({ outcome }: { outcome: string }) {
  if (outcome === 'ok') return <span className="step-mark ok" aria-hidden><IconCheck size={12} strokeWidth={3} /></span>
  return (
    <span className={`badge ${outcome === 'failed' ? 'bad' : 'warn'}`}>
      {outcome === 'failed' ? <IconClose size={12} strokeWidth={3} aria-hidden /> : <span aria-hidden>–</span>}
      {outcome}
    </span>
  )
}

function StepItem({ step, titles }: { step: Step; titles: Record<string, string> }) {
  const fields = fieldsOf(step.arguments)
  const { text, cut } = resultText(step.result)
  const tool = toolOf(step.tool)
  const title = stepTitle(step.tool, titles)
  return (
    <li className={`step ${step.outcome}`}>
      <div className="step-head">
        <ToolTile tool={tool} />
        <strong>{title}</strong>
        <span className="muted small">{toolName(tool)}</span>
        <Outcome outcome={step.outcome} />
      </div>
      {fields.length > 0 && (
        <>
          <p className="step-label">Asked</p>
          <Fields fields={fields} />
        </>
      )}
      {text && (
        <>
          <p className="step-label">Came back</p>
          <pre className="step-result" tabIndex={0} aria-label={`What “${title}” brought back`}>{text}</pre>
          {cut && <p className="hint">Only the start of what came back is kept here.</p>}
        </>
      )}
      {step.outcome === 'declined' && <p className="small muted">It was declined, so it did not run.</p>}
    </li>
  )
}

/** A reply's tool calls, folded to one line: their tools' icons and "3 steps", or the one step's own title. */
export function StepGroup({ steps, titles, summary }: { steps: Step[]; titles: Record<string, string>; summary?: string }) {
  const tools = [...new Set(steps.map((s) => toolOf(s.tool)))].slice(0, 4)
  const only = steps.length === 1 ? steps[0] : undefined
  const label = summary ?? (only ? stepTitle(only.tool, titles) : stepsSummary(steps))
  const unhappy = steps.find((s) => s.outcome !== 'ok')
  return (
    <details className="steps">
      <summary>
        <span className="steps-tiles">{tools.map((t) => <ToolTile key={t} tool={t} size={12} />)}</span>
        <span className="steps-label">{label}</span>
        {only && only.outcome !== 'ok' && <Outcome outcome={only.outcome} />}
        {!only && !summary && !unhappy && <span className="step-mark ok" aria-hidden><IconCheck size={12} strokeWidth={3} /></span>}
        {summary && stepsTrouble(steps) && <span className="muted">· {stepsTrouble(steps)}</span>}
      </summary>
      <ol className="steps-list">
        {steps.map((s) => <StepItem key={s.seq} step={s} titles={titles} />)}
      </ol>
    </details>
  )
}
