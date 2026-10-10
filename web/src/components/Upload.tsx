// A button that opens the file picker, and a bar for how far an upload has got. Shared by
// Meetings, Documents and the chat composer, so an upload looks the same wherever it starts.

import { useRef } from 'react'

export function PickFiles({ label, ariaLabel, icon, accept, multiple, folder, disabled, onPick, className }: {
  label: string
  /** For a button that shows only an icon: what it is called to a screen reader. */
  ariaLabel?: string
  icon?: React.ReactNode
  accept?: string
  multiple?: boolean
  folder?: boolean
  disabled?: boolean
  className?: string
  onPick: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple || folder}
        // Folder picking is not in the DOM typings; every current browser supports it.
        {...(folder ? { webkitdirectory: '', directory: '' } : {})}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = '' // picking the same file twice must fire again
          if (files.length) onPick(files)
        }}
      />
      <button type="button" className={className} disabled={disabled} aria-label={ariaLabel} onClick={() => input.current?.click()}>
        {icon}
        {label}
      </button>
    </>
  )
}

export function UploadProgress({ name, fraction }: { name: string; fraction: number }) {
  const percent = Math.round(fraction * 100)
  return (
    <div className="upload-progress">
      <div className="row spread"><span>Uploading {name}</span><span className="muted">{percent}%</span></div>
      <div className="bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
