/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-recall`.
 * @module dsh-recall/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-recall'

/** Cordis companion plugin name. */
export const name = 'tool-recall-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the recall tool is read-only — it never appends to the
 * log, so it owns no durable package-local event stream to validate; the
 * read-only contract is enforced by the tool itself rejecting every write path.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
