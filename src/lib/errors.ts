import 'server-only'
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { logger, errorSummary } from '@/lib/logger'

/**
 * Error model — docs/05 §2 (normative): every non-2xx response is
 *   { error: { code, message, details?, request_id } }
 * and carries an `x-request-id` header. Services throw AppError; route handlers
 * are wrapped in handleRoute() which does the mapping. Stack traces never leak.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  JOB_CLOSED: 'JOB_CLOSED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  PLAN_LIMIT: 'PLAN_LIMIT',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  INTERNAL: 'INTERNAL',
} as const
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

const HTTP_STATUS: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  JOB_CLOSED: 410,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  PLAN_LIMIT: 402,
  ALREADY_MEMBER: 409,
  INVITE_EXPIRED: 410,
  RATE_LIMITED: 429,
  INTEGRATION_ERROR: 502,
  AI_NOT_CONFIGURED: 400,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: ErrorCodeValue
  readonly details?: Record<string, unknown> | undefined
  override readonly cause?: unknown

  constructor(
    code: ErrorCodeValue,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = options?.details
    this.cause = options?.cause
  }
}

type JsonBody = object

/**
 * Wraps a route handler: try/catch → error envelope (docs/05 §2).
 * Returning a plain object from the handler yields 200 JSON; returning a
 * NextResponse is passed through untouched. `handleRoute` is the single place
 * where request_id is minted (also available to handlers via the ctx argument).
 */
export function handleRoute<A extends unknown[]>(
  handler: (ctx: { requestId: string }, ...args: A) => Promise<Response | JsonBody | void>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const requestId = crypto.randomUUID()
    try {
      const result = await handler({ requestId }, ...args)
      if (result instanceof Response) {
        result.headers.set('x-request-id', requestId)
        return result
      }
      if (result === undefined) return new Response(null, { status: 204 })
      return NextResponse.json(result, { headers: { 'x-request-id': requestId } })
    } catch (err) {
      return toErrorResponse(err, requestId)
    }
  }
}

function toErrorResponse(err: unknown, requestId: string): NextResponse {
  // Zod validation → 400 with per-field details
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {}
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_'
      details[key] = [...(details[key] ?? []), issue.message]
    }
    return errorResponse(ErrorCode.VALIDATION_ERROR, 'Some fields are invalid.', requestId, details)
  }

  if (err instanceof AppError) {
    if (err.code === 'INTERNAL') {
      logger.error('route failed (AppError INTERNAL)', {
        request_id: requestId,
        ...errorSummary(err),
      })
    } else {
      logger.warn('route error', { request_id: requestId, code: err.code, message: err.message })
    }
    return errorResponse(err.code, err.message, requestId, err.details)
  }

  // Unknown — log internals server-side, leak nothing.
  logger.error('route failed (unhandled)', { request_id: requestId, ...errorSummary(err) })
  return errorResponse(ErrorCode.INTERNAL, 'Something went wrong. Please try again.', requestId)
}

export function errorResponse(
  code: ErrorCodeValue,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}), request_id: requestId } },
    { status: HTTP_STATUS[code], headers: { 'x-request-id': requestId } },
  )
}
