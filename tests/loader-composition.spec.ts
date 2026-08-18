// Real Loader composition through cordis.yml: the recall tool must boot through
// the same loader path a deployment uses, and its model-facing schema plus the
// executed behavior — multi-keyword search, compaction-shadowed surface
// filtering, the mandatory result cap, and the current-step cap — must hold
// end to end.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolRecall from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  const value: Agent = {
    id: session.id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * A compaction-shaped session log: pre-compaction Q/A shadowed by a checkpoint
 * replacement, then a fresh step with an in-flight user message. Mirrors the
 * `compactSurfaceRegion()` transaction event order.
 */
function seededSession(): Session {
  const seed: SessionEvent[] = [
    {
      type: 'user/message', seq: 0, time: 1,
      data: {
        role: 'user', id: MessageId('msg-0'),
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'pre-compaction user question about recall' }],
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message', seq: 1, time: 2,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant', id: MessageId('msg-1'),
          source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
          content: [{ type: 'text', text: 'pre-compaction answer' }],
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'compaction/start', seq: 2, time: 3,
      data: { compactionId: CompactionId('recall-test'), turn: null },
    },
    {
      type: 'compaction/summary', seq: 3, time: 4,
      data: {
        compactionId: CompactionId('recall-test'),
        summary: [{ type: 'text', text: 'checkpoint summary' }],
        shadowedRange: { start: 0, end: 1 },
        shadowedSeqs: [0, 1],
        shadowedTokenCount: 42,
        provider: 'test-provider',
        model: 'test-model',
      },
    },
    {
      type: 'user/message', seq: 4, time: 5,
      data: {
        role: 'user', id: MessageId('msg-4'),
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'checkpoint summary text' }],
      },
      surfaceOp: { op: 'replace', start: 0, end: 1 },
      sourceEventSeqs: [2, 3, 0, 1],
    },
    {
      type: 'compaction/end', seq: 5, time: 6,
      data: { compactionId: CompactionId('recall-test'), turn: null },
    },
    { type: 'step/start', seq: 6, time: 7, data: { turn: 1, step: 2 } },
    {
      type: 'user/message', seq: 7, time: 8,
      data: {
        role: 'user', id: MessageId('msg-7'),
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'in-flight question of the current step' }],
      },
      surfaceOp: 'append',
    },
  ]
  return Session.create(SessionId('recall-loader-agent'), seed)
}

async function boot(overrides: { maxCharsPerEvent?: number } = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-remind-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'dsh-remind'",
    '  config:',
    '    maxResults: 10',
    `    maxCharsPerEvent: ${overrides.maxCharsPerEvent ?? 200}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-remind', ToolRecall],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function recall(ctx: Context, owner: Agent, arguments_: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('recall-test'),
    name: 'recall',
    arguments: arguments_,
    agent: owner,
  })
}

describe('tool-recall real Loader composition through cordis.yml', () => {
  it('registers the recall schema with the compaction-recall surface filter', async () => {
    const ctx = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'recall')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('shadowed')
    // ToolSchema.parameters is a loose JSON-schema record; narrow only the
    // surfaces entry the test asserts.
    const properties = schema?.parameters['properties'] as { surfaces?: { items?: { enum?: string[] } } } | undefined
    expect(properties?.surfaces?.items?.enum).toEqual(['current', 'shadowed', 'log-only'])
    const required = schema?.parameters['required'] as string[] | undefined
    expect(required).toEqual(['query'])
  }, 30_000)

  it('fails loading when a required config bound is missing', async () => {
    await expect(bootWithoutConfig()).rejects.toThrow('missing required value')
  }, 30_000)

  it('recalls compaction-shadowed pre-compaction content by keyword', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    const result = await recall(ctx, owner, { query: 'pre-compaction' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('Recalled 2 matching event(s)')
    expect(text).toContain('#0 user/message [shadowed]')
    expect(text).toContain('#1 assistant/message [shadowed]')
    expect(text).toContain('pre-compaction user question about recall')
    expect(text).toContain('pre-compaction answer')
    // No context rows without contextEvents: structural events are not hits.
    expect(text).not.toContain('#2 compaction/start')
    expect(text).not.toContain('checkpoint summary text')
  }, 30_000)

  it('matches only events containing every space-separated keyword', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    const both = await recall(ctx, owner, { query: 'pre-compaction question', max_results: 10 })
    expect(both.isError).toBe(false)
    const bothText = resultText(both)
    expect(bothText).toContain('Recalled 1 matching event(s)')
    expect(bothText).toContain('#0 user/message [shadowed]')
    // The other event lacks 'question' — no hit, no context row.
    expect(bothText).not.toContain('#1 assistant/message')
    const none = await recall(ctx, owner, { query: 'pre-compaction summary', max_results: 10 })
    expect(none.isError).toBe(false)
    expect(resultText(none)).toContain('Recalled 0 matching event(s)')
  }, 30_000)

  it('excludes events of the current step from recall', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    const result = await recall(ctx, owner, { query: 'in-flight' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('Recalled 0 matching event(s)')
  }, 30_000)

  it('filters by the optional surfaces argument', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    const result = await recall(ctx, owner, { query: 'pre-compaction', surfaces: ['current'], max_results: 10 })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('Recalled 0 matching event(s)')
  }, 30_000)

  it('caps hits at max_results and clamps oversized requests', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    // Both hits score equally ('pre-compaction' once each); the newest wins
    // the single slot.
    const capped = await recall(ctx, owner, { query: 'pre-compaction', max_results: 1 })
    expect(capped.isError).toBe(false)
    const text = resultText(capped)
    expect(text).toContain('Recalled 1 matching event(s)')
    expect(text).toContain('#1 assistant/message [shadowed]')
    expect(text).not.toContain('#0 user/message')
    const oversized = await recall(ctx, owner, { query: 'pre-compaction', max_results: 99 })
    expect(oversized.isError).toBe(false)
    expect(resultText(oversized)).toContain('Recalled 2 matching event(s)')
  }, 30_000)

  it('ranks hits by term density, newest first on ties', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-rank'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('r-0'), source: { kind: 'user' }, content: [{ type: 'text', text: 'beta beta gamma' }] }, surfaceOp: 'append' },
      { type: 'user/message', seq: 1, time: 2, data: { role: 'user', id: MessageId('r-1'), source: { kind: 'user' }, content: [{ type: 'text', text: 'beta' }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: 'beta', max_results: 1 })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    // Denser hit (two occurrences) wins the single slot.
    expect(text).toContain('#0 user/message [current]')
    expect(text).not.toContain('#1 user/message')
  }, 30_000)

  it('recruits CJK partial matches via n-grams', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-gram'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('g-0'), source: { kind: 'user' }, content: [{ type: 'text', text: '有一段历史记录在这里' }] }, surfaceOp: 'append' },
      { type: 'user/message', seq: 1, time: 2, data: { role: 'user', id: MessageId('g-1'), source: { kind: 'user' }, content: [{ type: 'text', text: '压缩历史内容 完整命中' }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: '压缩历史内容' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    // seq 0 lacks the full term but contains the '历史' gram — recruited as a hit.
    expect(text).toContain('Recalled 2 matching event(s)')
    expect(text).toContain('#0 user/message [current]')
    expect(text).toContain('#1 user/message [current]')
  }, 30_000)

  it('truncates long event texts around the first match', async () => {
    const ctx = await boot()
    const long = 'a'.repeat(100) + 'KEYWORD in the middle' + 'b'.repeat(100)
    const session = Session.create(SessionId('recall-truncate'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('t-0'), source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: 'keyword' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('KEYWORD in the middle')
    expect(text).toContain('省略')
  }, 30_000)

  it('windows long texts below the per-event cap (compact 2400-char budget)', async () => {
    const ctx = await boot({ maxCharsPerEvent: 5000 })
    const long = 'a'.repeat(1500) + 'KEYWORD in the middle' + 'b'.repeat(1500)
    const session = Session.create(SessionId('recall-window'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('w-0'), source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: 'keyword' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('KEYWORD in the middle')
    expect(text).toContain('省略')
    expect(text.length).toBeLessThan(2600)
  }, 30_000)

  it('recall results do not echo themselves, call arguments remain facts', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-echo'), [
      { type: 'tool/call', seq: 0, time: 1, data: { turn: 1, step: 1, callId: CallId('echo-0'), name: 'recall', arguments: JSON.stringify({ query: 'other' }) } },
      { type: 'tool/result', seq: 1, time: 2, data: { turn: 1, step: 1, message: { role: 'user', id: MessageId('er-0'), content: [{ type: 'tool-result', toolCallId: CallId('echo-0'), content: [{ type: 'text', text: 'Recalled 1 matching event(s): needle here' }], isError: false }], source: { kind: 'tool', callId: CallId('echo-0') } } }, surfaceOp: 'append' },
      { type: 'user/message', seq: 2, time: 3, data: { role: 'user', id: MessageId('e-0'), source: { kind: 'user' }, content: [{ type: 'text', text: 'needle in real content' }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    // 'needle' appears in the self-result AND in real content: only the real event hits.
    const result = await recall(ctx, owner, { query: 'needle' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('Recalled 1 matching event(s)')
    expect(text).toContain('#2 user/message')
    expect(text).not.toContain('#0 tool/call')
    expect(text).not.toContain('#1 tool/result')
    // The self call's own query is a fact: it matches via its arguments.
    const byQuery = await recall(ctx, owner, { query: 'other' })
    expect(byQuery.isError).toBe(false)
    expect(resultText(byQuery)).toContain('#0 tool/call')
  }, 30_000)

  it('tells the agent when the session never compacted', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-fresh'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('f-0'), source: { kind: 'user' }, content: [{ type: 'text', text: 'just a short conversation' }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: 'nonexistent-thing' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('还没有发生过压缩')
  }, 30_000)

  it('rejects queries longer than 200 characters', async () => {
    const ctx = await boot()
    const owner = agent(ctx, seededSession())
    const result = await recall(ctx, owner, { query: 'x'.repeat(201) })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('at most 200')
  }, 30_000)

  it('folds full-width query characters onto ASCII text via NFKC', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-nfkc'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('n-0'), source: { kind: 'user' }, content: [{ type: 'text', text: 'abc plain' }] }, surfaceOp: 'append' },
    ])
    const owner = agent(ctx, session)
    // 'ａｂｃ' is full-width: not NFKC-stable, so the full NFKC path runs.
    const result = await recall(ctx, owner, { query: 'ａｂｃ' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('#0 user/message [current]')
  }, 30_000)

  it('fast path: an NFKC-stable query misses full-width variants in event text', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('recall-fastpath'), [
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: MessageId('f-0'), source: { kind: 'user' }, content: [{ type: 'text', text: 'ＡＢＣ full-width' }] }, surfaceOp: 'append' },
      { type: 'compaction/start', seq: 1, time: 2, data: { compactionId: CompactionId('recall-fastpath'), turn: null } },
    ])
    const owner = agent(ctx, session)
    const result = await recall(ctx, owner, { query: 'abc' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    expect(text).toContain('Recalled 0 matching event(s)')
    expect(text).not.toContain('#0 user/message')
  }, 30_000)
})

/** Boot without the config block to prove the bounds are required. */
async function bootWithoutConfig(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-remind-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'dsh-remind'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-remind', ToolRecall],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}
