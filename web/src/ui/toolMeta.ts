// What each tool looks like and where its page is: one place, so the Overview, the approval card
// and anything else that shows "a tool" agree.

import type { ComponentType } from 'react'
import type { ToolName } from '../charts/palette'
import { IconAudiobooks, IconChat, IconDocuments, IconMail, IconMeetings } from './icons'
import type { Section } from './sections'

type Icon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>

export const TOOL_ICON: Record<ToolName, Icon> = {
  'meet-ai': IconMeetings,
  'docu-ai': IconDocuments,
  'mail-ai': IconMail,
  assistant: IconChat,
  audiobook: IconAudiobooks,
}

export const TOOL_SECTION: Record<ToolName, Section> = {
  'meet-ai': 'meetings',
  'docu-ai': 'documents',
  'mail-ai': 'mail',
  assistant: 'chat',
  audiobook: 'audiobooks',
}

/** "start_render" -> "Start render". */
export const humanise = (name: string): string => {
  const words = name.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
