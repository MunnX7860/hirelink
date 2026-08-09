import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'

/** Error-envelope contract — docs/05 §2. */
describe('handleRoute — error model', () => {
  it('returns 200 JSON for object results and sets x-request-id', async () => {
    const res = await handleRoute(async () => ({ ok: true }))()
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('maps AppError codes to the documented HTTP statuses', async () => {
    const cases: Array<[keyof typeof ErrorCode, number]> = [
      ['VALIDATION_ERROR', 400],
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['JOB_CLOSED', 410],
      ['RATE_LIMITED', 429],
      ['INTEGRATION_ERROR', 502],
      ['INTERNAL', 500],
    ]
    for (const [code, status] of cases) {
      const res = await handleRoute(async () => {
        throw new AppError(code, 'msg')
      })()
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.error.code).toBe(code)
      expect(body.error.message).toBe('msg')
      expect(body.error.request_id).toBeTruthy()
    }
  })

  it('maps ZodError to 400 with per-field details', async () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(18) })
    const res = await handleRoute(async () => {
      schema.parse({ email: 'nope', age: 12 })
      return {}
    })()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(Object.keys(body.error.details)).toEqual(expect.arrayContaining(['email', 'age']))
  })

  it('never leaks internals for unknown errors (500 generic message)', async () => {
    const res = await handleRoute(async () => {
      throw new Error('db connection string: postgres://secret@host')
    })()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INTERNAL')
    expect(JSON.stringify(body)).not.toContain('postgres://')
  })
})
