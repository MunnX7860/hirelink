import 'server-only'

/**
 * Structured JSON logs to stdout (Vercel log drain) — docs/03 §8.
 * NEVER log credentials, tokens, resume text, or applicant PII beyond IDs (docs/14 §4).
 * Context keys matching sensitive patterns are redacted automatically.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const SENSITIVE_KEY = /token|secret|credential|password|api[_-]?key|authorization|cookie/i

function redact(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : v]),
  )
}

function write(level: Level, msg: string, context: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...redact(context),
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, context?: Record<string, unknown>) => write('debug', msg, context),
  info: (msg: string, context?: Record<string, unknown>) => write('info', msg, context),
  warn: (msg: string, context?: Record<string, unknown>) => write('warn', msg, context),
  error: (msg: string, context?: Record<string, unknown>) => write('error', msg, context),
}

/** Serialize unknown thrown values for logs without leaking internals. */
export function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error_name: err.name, error_message: err.message }
  return { error_name: 'UnknownError' }
}
