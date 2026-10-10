// Call a tool by name, as a button does, and turn a tool's own failure into a thrown error: a tool
// that failed returns {error} inside an otherwise successful response, and showing that as a result
// would put a blank card where the reason should be.

import { runAction } from './api'

export async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await runAction<T & { error?: string }>(tool, args)
  const output = result.output
  if (result.outcome && result.outcome !== 'ok') throw new Error(String(output))
  if (output && typeof output === 'object' && 'error' in output && output.error) throw new Error(String(output.error))
  return output as T
}
