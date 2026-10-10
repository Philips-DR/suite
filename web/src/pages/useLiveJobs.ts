// What is running right now, across the tools that run long: a book being read or rendered, a
// recording being transcribed, a meeting being recorded. Each is a read-only status call, which is
// neither audited nor noted for the model -- looking is not acting -- so polling is free of side effects.

import { call } from '../call'
import { useAppState } from '../state'
import { usePoll } from '../usePoll'

export interface BookJob {
  id: string
  kind: 'analyse' | 'render' | 'voice' | 'sample'
  target: string
  state: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled'
  phase: string
  percent: number | null
  chapter: number | null
  chapter_title: string | null
  eta: string | null
}

export interface TranscriptionJob {
  id: string
  audio: string
  state: 'running' | 'done' | 'failed' | 'interrupted'
  phase: string
  percent: number | null
  eta: string | null
}

export interface RecordingSession {
  id: string
  state: 'recording' | 'orphaned' | 'stopped'
  recorded_seconds?: number
}

export function useLiveJobs(every = 5000) {
  const { tools } = useAppState()
  const book = usePoll(() => (tools.has('audiobook__job_status') ? call<{ job: BookJob | null }>('audiobook__job_status') : Promise.resolve({ job: null })), every)
  const transcription = usePoll(() => (tools.has('meet_ai__transcription_status') ? call<{ job: TranscriptionJob | null }>('meet_ai__transcription_status') : Promise.resolve({ job: null })), every)
  const recording = usePoll(() => (tools.has('meet_ai__recording_status') ? call<{ session: RecordingSession | null }>('meet_ai__recording_status') : Promise.resolve({ session: null })), every)
  return {
    book: book.data?.job ?? null,
    transcription: transcription.data?.job ?? null,
    recording: recording.data?.session ?? null,
    loaded: book.data !== null || transcription.data !== null,
  }
}
