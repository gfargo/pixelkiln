/**
 * The kinds of failure a caller can act on differently.
 *
 * Most errors in this codebase are plain `Error`s with a good message, and
 * that stays true: the message is for a person. A `code` is for a program.
 * The gallery turns one into an HTTP status, the CLI into an exit code, and
 * an integration decides whether to retry, ask, or stop without matching on
 * message text that may be reworded.
 *
 * The set is deliberately small. A new code earns its place when some caller
 * would branch on it; until then a plain Error is the right type.
 */
export type ErrorCode =
  /** Bad flags or arguments. Nothing was read or written. */
  | "usage"
  /** The manifest, lockfile, or workspace catalog is missing or invalid. */
  | "project"
  /** A provider rejected a request or answered with something unusable. */
  | "provider"
  /** A file on disk differs from what the record expects; nothing was overwritten. */
  | "refused-overwrite"
  /** The run would spend past a ceiling, or the balance cannot cover it. */
  | "budget"
  /** The provider recorded for this work does not offer the operation. */
  | "capability"

/** Exit codes the CLI maps each kind to. 1 stays the code for anything untyped. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  usage: 2,
  project: 3,
  provider: 4,
  "refused-overwrite": 5,
  budget: 6,
  capability: 7,
}

export interface PixelKilnErrorOptions {
  /** One line of what to do next, printed under the message by the CLI. */
  hint?: string
  cause?: unknown
}

export class PixelKilnError extends Error {
  readonly code: ErrorCode
  readonly hint?: string

  constructor(message: string, code: ErrorCode, opts: PixelKilnErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = "PixelKilnError"
    this.code = code
    if (opts.hint) this.hint = opts.hint
  }
}

export class UsageError extends PixelKilnError {
  constructor(message: string, opts?: PixelKilnErrorOptions) {
    super(message, "usage", opts)
    this.name = "UsageError"
  }
}

export class ProjectError extends PixelKilnError {
  constructor(message: string, opts?: PixelKilnErrorOptions) {
    super(message, "project", opts)
    this.name = "ProjectError"
  }
}

export class ProviderError extends PixelKilnError {
  /** Registry id of the provider that failed. */
  readonly provider: string
  /** HTTP status when the failure was a response, otherwise undefined. */
  readonly status?: number

  constructor(provider: string, message: string, opts: PixelKilnErrorOptions & { status?: number } = {}) {
    super(message, "provider", opts)
    this.name = "ProviderError"
    this.provider = provider
    if (opts.status !== undefined) this.status = opts.status
  }
}

export class OverwriteRefusedError extends PixelKilnError {
  /** The file(s) left untouched. */
  readonly files: string[]

  constructor(message: string, files: string[], opts?: PixelKilnErrorOptions) {
    super(message, "refused-overwrite", opts)
    this.name = "OverwriteRefusedError"
    this.files = files
  }
}

export class BudgetError extends PixelKilnError {
  constructor(message: string, opts?: PixelKilnErrorOptions) {
    super(message, "budget", opts)
    this.name = "BudgetError"
  }
}

/** The code of any thrown value, or undefined for an untyped error. */
export function errorCode(err: unknown): ErrorCode | undefined {
  return err instanceof PixelKilnError ? err.code : undefined
}

/** What a process should exit with after failing on `err`. */
export function exitCodeFor(err: unknown): number {
  const code = errorCode(err)
  return code ? EXIT_CODES[code] : 1
}
