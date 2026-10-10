// Drop files anywhere on a card to upload them: the file picker stays, and this is the shortcut
// on a desktop. Files are handed to the same handler the picker uses, after a check of what the
// panel accepts, so a wrong kind of file is named instead of silently ignored.

import { useRef, useState, type ReactNode } from 'react'
import { IconUpload } from './icons'

export function DropZone({ onFiles, accepts, label, onRefuse, disabled = false, children, className = '' }: {
  onFiles: (files: File[]) => void
  accepts: (file: File) => boolean
  label: string
  onRefuse?: (names: string[]) => void
  disabled?: boolean
  children: ReactNode
  className?: string
}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0) // dragenter and dragleave fire for every child; only the outermost counts

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  return (
    <div
      className={`dropzone ${over ? 'over' : ''} ${className}`}
      onDragEnter={(e) => { if (disabled || !hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true) }}
      onDragOver={(e) => { if (disabled || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false) } }}
      onDrop={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        const ok = files.filter(accepts)
        const refused = files.filter((f) => !accepts(f)).map((f) => f.name)
        if (refused.length) onRefuse?.(refused)
        if (ok.length) onFiles(ok)
      }}
    >
      {children}
      {over && (
        <div className="drop-overlay" aria-hidden>
          <IconUpload size={26} strokeWidth={1.8} />
          <strong>{label}</strong>
        </div>
      )}
    </div>
  )
}
