/**
 * Model-facing recall tool: search and read the calling agent's OWN session
 * log — the complete durable event history, including events shadowed by
 * compaction. Compaction never deletes events: it replaces a visible surface
 * range with a summary checkpoint, and the replaced events stay in the log
 * classified as `shadowed`. This tool is the model's way back to that content.
 *
 * Scope is deliberately single-session and read-only: it reads
 * `exec.agent.session.events` (the same append-only log everything else uses)
 * and never appends. A fork child's session carries its parent's completed-turn
 * log prefix, so a fork recalls parent history too. There is no cross-session
 * access and no authorization surface — the tool can only ever see the caller's
 * own log.
 * @module dsh-recall
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildSessionEventRecords,
  extractSessionEventText,
  type SessionEventSurface,
} from '@deepseek-ai/dsh-session-query'

export const name = 'tool-recall'
export const inject = ['tools']

/** Deployment-chosen recall bounds. */
export interface Config {
  /**
   * Hard cap on recalled events returned per call; `limit` clamps to it.
   */
  maxResults: number
  /**
   * Hard cap on characters of each event's extracted text returned; longer
   * text is cut with a trailing ellipsis.
   */
  maxCharsPerEvent: number
}

/** Schemastery configuration for the recall tool consumer. */
export const Config: z<Config> = z.object({
  maxResults: z.natural().min(1).required(),
  maxCharsPerEvent: z.natural().min(1).required(),
})

/** The three session-event surface classifications, as a runtime set. */
const SURFACES = ['current', 'shadowed', 'log-only'] as const

const DESCRIPTION = 'Search and read the CALLING AGENT\'S OWN session log — the complete '
  + 'durable event history of this session, including events shadowed by compaction. '
  + 'Compaction never deletes events: it replaces a visible range with a summary checkpoint, '
  + 'and the replaced events stay in the log as `shadowed`. '
  + 'Use `surfaces: ["shadowed"]` to retrieve pre-compaction content, `seq` to read one exact '
  + 'event (add `window` for its neighbors), `query` for a case-insensitive literal substring '
  + 'over event text, and `event_types` / `seq_from` / `seq_to` to narrow. Events of the '
  + 'current step are excluded. Results are capped by deployment config. '
  + 'Works only on your own session; a fork inherits its parent\'s completed-turn log prefix, '
  + 'so it recalls parent history too.'

/**
 * Register the `recall` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's recall bounds.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'recall',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: 'Case-insensitive literal substring over event text. Mutually exclusive with `seq`.',
      },
      seq: {
        type: 'integer',
        description: 'Read the exact event with this seq, plus `window` neighbors. Mutually exclusive with `query`.',
      },
      window: {
        type: 'integer',
        description: 'With `seq`: how many preceding and following events to include. Requires `seq`.',
      },
      event_types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only events with one of these types (e.g. user/message, assistant/message, tool/result, compaction/summary).',
      },
      surfaces: {
        type: 'array',
        items: { type: 'string', enum: [...SURFACES] },
        description: 'Only events with one of these surface classifications. `shadowed` = content replaced by compaction; `log-only` = events never on the model-visible surface.',
      },
      seq_from: {
        type: 'integer',
        description: 'Only events with seq >= this value.',
      },
      seq_to: {
        type: 'integer',
        description: 'Only events with seq <= this value.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum events returned; clamped to the deployment maxResults.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: {
            type: 'integer',
            required: true,
            description: 'Total matching events before the limit was applied.',
          },
          events: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                type: { type: 'string', required: true },
                surface: { type: 'string', required: true, enum: [...SURFACES] },
                time: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Recalled ${value.count} matching event(s), returned ${value.events.length}:`,
          ...value.events.map(event =>
            `#${event.seq} ${event.type} [${event.surface}] (time ${event.time}): ${event.text}`),
        ].join('\n'),
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // The log belongs to the calling agent session; a non-agent caller has
        // no session to recall. Reject rather than silently read nothing.
        throw new Error('recall requires an owning agent session')
      }
      if (args.seq !== undefined && args.query !== undefined) {
        throw new Error('recall: `seq` and `query` are mutually exclusive')
      }
      if (args.window !== undefined && args.seq === undefined) {
        throw new Error('recall: `window` requires `seq`')
      }
      return Promise.resolve(runRecall(exec.agent.session, args, config))
    },
    presentCall: args => ({ card: 'generic', title: 'Recall session history', kind: 'other', rawInput: args }),
  }))
}

/** Recall arguments as the schema boundary delivers them. */
interface RecallArgs {
  query?: string
  seq?: number
  window?: number
  event_types?: string[]
  surfaces?: SessionEventSurface[]
  seq_from?: number
  seq_to?: number
  limit?: number
}

/** A recalled event as returned to the model. */
interface RecallEvent {
  seq: number
  type: string
  surface: SessionEventSurface
  time: number
  text: string
}

/**
 * Execute one recall over the calling agent's own session log.
 * @param session - the calling agent's session (log source and identity).
 * @param args - validated recall arguments.
 * @param config - deployment bounds (limit cap and per-event text cap).
 * @returns matched count and the capped result list.
 */
function runRecall(
  session: Session,
  args: RecallArgs,
  config: Config,
): { count: number; events: RecallEvent[] } {
  const events = session.events

  // Surface classification folds the WHOLE log (a replacement range can only
  // be resolved against complete history), so classify before any filtering.
  const surfaceBySeq = new Map<number, SessionEventSurface>(
    buildSessionEventRecords(session.id, events).map(record => [record.seq, record.surface]),
  )
  const surfaceOf = (event: SessionEvent): SessionEventSurface =>
    surfaceBySeq.get(event.seq) ?? 'log-only'

  // The current step's events are the model's own in-flight output — already
  // in context, and not history to recall. Exclude everything from the last
  // step/start onward, mirroring session-query's current-session cap.
  let currentStepStart = Infinity
  for (const event of events) {
    if (event.type === 'step/start') currentStepStart = event.seq
  }
  const eligible = events.filter(event => event.seq < currentStepStart)

  const lowerQuery = (args.query ?? '').toLowerCase()
  const surfaceFilter = args.surfaces
  const typeFilter = args.event_types
  const matches = (event: SessionEvent): boolean => {
    if (typeFilter !== undefined && !typeFilter.includes(event.type)) return false
    if (surfaceFilter !== undefined && !surfaceFilter.includes(surfaceOf(event))) return false
    if (args.seq_from !== undefined && event.seq < args.seq_from) return false
    if (args.seq_to !== undefined && event.seq > args.seq_to) return false
    if (lowerQuery.length > 0) {
      const text = extractSessionEventText(event)
      if (!text.toLowerCase().includes(lowerQuery)) return false
    }
    return true
  }

  let matched = eligible.filter(matches)
  if (args.seq !== undefined) {
    // `seq` reads one exact event: widen to its neighbors first, then apply
    // the remaining filters to the neighborhood.
    const index = eligible.findIndex(event => event.seq === args.seq)
    if (index === -1) return { count: 0, events: [] }
    const halfWindow = Math.min(Math.max(args.window ?? 0, 0), config.maxResults)
    matched = eligible
      .slice(Math.max(0, index - halfWindow), index + halfWindow + 1)
      .filter(matches)
  }

  const limit = Math.min(Math.max(args.limit ?? config.maxResults, 0), config.maxResults)
  return {
    count: matched.length,
    events: matched.slice(0, limit).map(event => {
      const text = extractSessionEventText(event)
      return {
        seq: event.seq,
        type: event.type,
        surface: surfaceOf(event),
        time: event.time,
        text: text.length > config.maxCharsPerEvent
          ? `${text.slice(0, config.maxCharsPerEvent)}…`
          : text,
      }
    }),
  }
}
