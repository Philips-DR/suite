// The pages of the app, in one list: the sidebar, the phone's tab bar, the command palette and
// each page's heading all read it.
//
// `tool` is the fixed identity colour of the tool behind a page (charts/palette.ts): the same
// hue on the nav tile, in the charts, and on the tool's health card. Colour follows the entity.

import {
  IconAudiobooks, IconChat, IconDocuments, IconHistory, IconMail, IconMeetings, IconMemory,
  IconOverview, IconSettings,
} from './icons'
import type { ComponentType } from 'react'

export type Section =
  | 'overview' | 'chat' | 'meetings' | 'documents' | 'audiobooks' | 'mail' | 'memory' | 'history' | 'settings'

export interface SectionInfo {
  id: Section
  label: string
  title: string
  blurb: string
  group: 'Workspace' | 'Tools' | 'System'
  icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
  tool?: 'meet-ai' | 'docu-ai' | 'mail-ai' | 'audiobook' | 'assistant'
  keywords: string
}

export const SECTIONS: SectionInfo[] = [
  { id: 'overview', label: 'Overview', title: 'Overview', blurb: 'What is happening, and what needs you.', group: 'Workspace', icon: IconOverview, keywords: 'home dashboard charts activity status' },
  { id: 'chat', label: 'Chat', title: 'Chat', blurb: 'Ask for anything the tools can do.', group: 'Workspace', icon: IconChat, tool: 'assistant', keywords: 'assistant message ask talk' },
  { id: 'meetings', label: 'Meetings', title: 'Meetings', blurb: 'Record, transcribe, and write up what was said.', group: 'Tools', icon: IconMeetings, tool: 'meet-ai', keywords: 'record transcribe notes minutes audio' },
  { id: 'documents', label: 'Documents', title: 'Documents', blurb: 'Turn markdown into a formatted Google Doc.', group: 'Tools', icon: IconDocuments, tool: 'docu-ai', keywords: 'markdown google doc build' },
  { id: 'audiobooks', label: 'Audiobooks', title: 'Audiobooks', blurb: 'Turn a PDF into an audiobook in a voice you choose.', group: 'Tools', icon: IconAudiobooks, tool: 'audiobook', keywords: 'pdf book voice render listen' },
  { id: 'mail', label: 'Mail', title: 'Mail', blurb: 'Read, search and reply.', group: 'Tools', icon: IconMail, tool: 'mail-ai', keywords: 'gmail email inbox draft send' },
  { id: 'memory', label: 'Memory', title: 'Memory', blurb: 'What the assistant knows about you.', group: 'System', icon: IconMemory, tool: 'assistant', keywords: 'remember facts people spellings' },
  { id: 'history', label: 'History', title: 'History', blurb: 'Every action, kept across restarts.', group: 'System', icon: IconHistory, keywords: 'audit log calls' },
  { id: 'settings', label: 'Settings', title: 'Settings', blurb: 'Connections, logins and health.', group: 'System', icon: IconSettings, keywords: 'connections status login aws network' },
]

export const sectionById = (id: Section): SectionInfo => SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]!

/** The four tabs a phone has room for; everything else is behind "More". */
export const TAB_SECTIONS: Section[] = ['overview', 'chat', 'meetings', 'audiobooks']
