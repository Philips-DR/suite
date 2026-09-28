// The one step a separate web app costs: the backend no longer hands this page its token,
// so the person copies it across once from the terminal where the backend started. The
// browser keeps it until the backend restarts with a new one, and then this asks again.

import { useState } from 'react'
import { API_URL, connect, hasToken } from '../api'

export function Connect() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [trying, setTrying] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setTrying(true)
    setError('')
    try {
      await connect(value)
      // Reload rather than reconnect piecemeal: every part of the app picks the token up
      // from storage on start, including the event stream.
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setTrying(false)
    }
  }

  return (
    <div className="connect" role="dialog" aria-labelledby="connect-title">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h2 id="connect-title">{hasToken() ? 'The assistant restarted' : 'Connect to the assistant'}</h2>
        <p>
          Paste the <strong>access token</strong> printed where the backend started — the line that reads
          <code> access token: …</code>
        </p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="access token"
          aria-label="Access token"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="row">
          <button className="primary" type="submit" disabled={!value.trim() || trying}>
            {trying ? 'Connecting…' : 'Connect'}
          </button>
          <span className="muted small">Backend: {API_URL}</span>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  )
}
