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

/** A button for a tool that asks first. The first press returns what the tool would do (its own preview),
 * and only a second, confirmed press acts. Failures are thrown, as `call` does. */
export async function ask<T>(
  tool: string,
  args: Record<string, unknown> = {},
  confirmed = false,
): Promise<{ confirm: true; preview: string | null } | { confirm: false; output: T }> {
  const result = await runAction<T & { error?: string }>(tool, args, confirmed)
  if (result.needs_confirmation) return { confirm: true, preview: result.preview ?? null }
  const output = result.output
  if (result.outcome && result.outcome !== 'ok') throw new Error(String(output))
  if (output && typeof output === 'object' && 'error' in output && output.error) throw new Error(String(output.error))
  return { confirm: false, output: output as T }
}
