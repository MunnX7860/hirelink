'use client'

/**
 * Browser-side API helper — consumes the docs/05 §2 error envelope.
 * Throws `ApiError` (carries `code` + field `details`) so components can map
 * VALIDATION_ERROR field messages onto forms.
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown> | undefined

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** zod field errors for a given field (docs/05 §2 details shape). */
  fieldError(field: string): string | undefined {
    const value = this.details?.[field]
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return undefined
  }
}

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
}

export async function api<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  const res = await fetch(path, init)

  if (res.status === 204) return undefined as T

  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> }
  } | null

  if (!res.ok) {
    const err = json?.error ?? {}
    throw new ApiError(
      res.status,
      err.code ?? 'UNKNOWN',
      err.message ?? `Request failed (${res.status})`,
      err.details,
    )
  }
  return json as T
}

/** Mutation helper for TanStack Query / plain awaits with a uniform surface. */
export function mutate<T = unknown>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
) {
  return api<T>(path, { method, ...(body !== undefined ? { body } : {}) })
}
