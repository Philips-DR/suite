// The gate, in a browser. Shown inline in chat, and as a tray on every other page: an approval is
// waiting on you whichever page you happen to be on.

import { useState, type CSSProperties } from 'react'
import { answerApproval, toolLabel, type Approval } from '../api'
import { isTool, toolColor, toolName, toolOf } from '../charts/palette'
import { IconCheck, IconClose } from '../ui/icons'
import { TOOL_ICON, humanise } from '../ui/toolMeta'

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
  const hasArguments = Object.keys(approval.arguments).length > 0

  return (
    <div className="approval" role="alertdialog" aria-label={`Approve ${toolLabel(approval.tool)}?`}>
      <div className="approval-head">
        <span className="approval-kicker">Needs your approval</span>
      </div>

      <div className="approval-what">
        <span className="navtile" style={{ '--tile': toolColor(tool) } as CSSProperties}>{Icon ? <Icon size={18} strokeWidth={2} aria-hidden /> : null}</span>
        <div>
          <strong>{humanise(approval.name)}</strong>
          <span className="approval-tool">{isTool(tool) ? toolName(tool) : tool} · {toolLabel(approval.tool)}</span>
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

      {hasArguments && (
        <details className="approval-args" open={!approval.preview}>
          <summary>Details</summary>
          <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
        </details>
      )}

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
