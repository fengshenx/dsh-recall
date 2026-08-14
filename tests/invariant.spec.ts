import { describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as RecallInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('recall invariant companion', () => {
  it('registers its explained-empty ownership and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(RecallInvariant)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
