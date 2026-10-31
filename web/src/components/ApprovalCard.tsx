// The gate, in a browser. Shown inline in chat, and as a tray on every other page: an approval is
// waiting on you whichever page you happen to be on.

import { useState, type CSSProperties } from 'react'
import { answerApproval, type Approval } from '../api'
import { isTool, toolColor, toolName, toolOf } from '../charts/palette'
import { IconCheck, IconClose } from '../ui/icons'
import { TOOL_ICON, humanise } from '../ui/toolMeta'
import { Fields } from './StepDetails'
import { fieldsOf } from './toolSteps'

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const answer = async (approve: boolean) => {
    setSending(true)
    setError('')
    try {
      await answerApproval(approval.id, approve)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSending(false)
    }
  }

  const tool = toolOf(approval.tool)
  const Icon = isTool(tool) ? TOOL_ICON[tool] : null
  // What the tool calls itself ("Write a new draft"), and what it was asked as fields a person reads: an email's
  // body was a line of JSON that ran off a phone's screen, so it could be approved half read.
  const title = approval.title || humanise(approval.name)
  const fields = fieldsOf(approval.arguments)

  return (
    <div className="approval" role="alertdialog" aria-label={`Approve: ${title}?`}>
      <div className="approval-head">
        <span className="approval-kicker">Needs your approval</span>
      </div>

      <div className="approval-what">
        <span className="navtile" style={{ '--tile': toolColor(tool) } as CSSProperties}>{Icon ? <Icon size={18} strokeWidth={2} aria-hidden /> : null}</span>
        <div>
          <strong>{title}</strong>
          <span className="approval-tool">{toolName(tool)}</span>
        </div>
      </div>

      {approval.preview ? (
        // Rendered as text, never HTML: this is an email body or a transcript, written by
        // someone else, and it must not be able to become markup on this page.
        <pre className="approval-preview">{approval.preview}</pre>
      ) : approval.preview_expected ? (
        <p className="approval-warning">
          This action offers a preview of what it would do, and the preview could not be produced.
          Approving means approving it unseen.
        </p>
      ) : null}

      {fields.length > 0 && (approval.preview
        ? (
          <details className="approval-args">
            <summary>Details</summary>
            <Fields fields={fields} />
          </details>
        )
        : <Fields fields={fields} />)}

      {error && <p className="error">{error}</p>}

      <div className="approval-actions">
        <button className="primary" disabled={sending} onClick={() => void answer(true)}>
          <IconCheck size={16} strokeWidth={2.6} aria-hidden />{sending ? 'Sending…' : 'Approve'}
        </button>
        <button disabled={sending} onClick={() => void answer(false)}>
          <IconClose size={16} aria-hidden />Decline
        </button>
      </div>
    </div>
  )
}
