import type { docs_v1 } from 'googleapis'
import type { Block, DocPlan } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { codeBlockStyleRequests, compileBlocks, quoteStyleRequest, ruleStyleRequest } from './blocks.js'
import { bulletRequestsDescending } from './lists.js'
import { documentStyleRequest, namedStyleRequests } from './namedStyles.js'
import { renderTextBlocks } from './text.js'

export interface CompiledDocument {
  /** Phase 1: theme, applied before any content so it inherits correctly. */
  themeRequests: docs_v1.Schema$Request[]
  /** Phase 2/3: insertText plus every non-length-changing style. Safe as one batch — see below. */
  contentRequests: docs_v1.Schema$Request[]
  /** Phase 4: bullets, already sorted descending. The only length-changing requests in this build. */
  bulletRequests: docs_v1.Schema$Request[]
}

/**
 * Pure: DocPlan + Theme -> every Request a build issues, with no network involved. This is what
 * makes the whole document snapshot-testable, not just its individual pieces — an unexplained diff
 * here is a bug until proven otherwise.
 *
 * No readback is threaded through here, unlike the general four-phase sequence: a fenced code block
 * is one paragraph like any other (its lines joined by `\v`, not separate paragraphs), so it still
 * fits inside one insert pass with exactly one length-changing step (bullets) applied last — the
 * insert-time cursor stays valid throughout. M3's `insertTable` placeholders are what will finally
 * force a real readback between insert and style, since a table's cell start indices can't be known
 * until the table itself has actually been inserted.
 */
export function compileDocument(theme: Theme, plan: DocPlan): CompiledDocument {
  const chapterBlocks: Block[][] = plan.chapters.map((c) => c.blocks)
  const withDividers = chapterBlocks.flatMap((blocks, i) =>
    i === 0 ? blocks : [{ kind: 'rule' } as Block, ...blocks],
  )
  const compiled = compileBlocks(withDividers)

  const rendered = renderTextBlocks(compiled.textBlocks, theme)
  const ruleRequests = compiled.ruleIndices.map((i) => ruleStyleRequest(rendered.ranges[i]!, theme))
  const codeBlockRequests = compiled.codeBlockIndices.flatMap((i) =>
    codeBlockStyleRequests(rendered.ranges[i]!, theme),
  )
  // Shallowest first: a nested blockquote's own call is issued after its enclosing quote's, so its
  // deeper indent/border wins on the sub-range both calls touch. Both are non-length-changing, so
  // this ordering affects only which value wins, never index validity.
  const quoteRequests = [...compiled.quoteRuns]
    .sort((a, b) => a.depth - b.depth)
    .map((run) => quoteStyleRequest(rendered.ranges, run, theme))

  return {
    themeRequests: [documentStyleRequest(theme), ...namedStyleRequests(theme)],
    contentRequests: [...rendered.requests, ...ruleRequests, ...codeBlockRequests, ...quoteRequests],
    bulletRequests: bulletRequestsDescending(rendered.ranges, compiled.listRuns),
  }
}
