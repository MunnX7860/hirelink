import { describe, it, expect } from 'vitest'
import { CreateJobInput, canTransitionJob } from '@/features/jobs/schemas'
import {
  ApplyInput,
  UpdateApplicationInput,
  nextPipelineStatus,
  statusBeforeArchive,
} from '@/features/applications/schemas'
import { relativeTime } from '@/lib/time'

/** Domain schemas + pure state machines — docs/13 §2.1. */

describe('ApplyInput (docs/05 §4.2)', () => {
  it('accepts a valid minimal payload with honeypot empty', () => {
    const out = ApplyInput.parse({
      full_name: 'Asha Verma',
      email: 'asha@example.com',
      website: '',
    })
    expect(out.source).toBe('direct') // default
  })
  it('rejects invalid emails and unknown fields (strict)', () => {
    expect(() => ApplyInput.parse({ full_name: 'Asha', email: 'nope' })).toThrow()
    expect(() => ApplyInput.parse({ full_name: 'Asha', email: 'a@b.co', extra_field: 1 })).toThrow()
  })
  it('rejects a filled honeypot', () => {
    expect(() =>
      ApplyInput.parse({ full_name: 'Bot', email: 'bot@spam.io', website: 'http://spam' }),
    ).toThrow()
  })
})

describe('CreateJobInput (docs/05 §4.1) + transitions', () => {
  it('applies documented form_config defaults', () => {
    const out = CreateJobInput.parse({ title: 'Store Manager' })
    expect(out.form_config).toEqual({ phone: 'optional', resume: 'required', cover_note: 'hidden' })
    expect(out.description).toBe('')
  })
  it('enforces transition matrix: draft→active→closed, active↔closed', () => {
    expect(canTransitionJob('draft', 'active')).toBe(true)
    expect(canTransitionJob('draft', 'closed')).toBe(true)
    expect(canTransitionJob('active', 'closed')).toBe(true)
    expect(canTransitionJob('closed', 'active')).toBe(true)
    expect(canTransitionJob('active', 'draft')).toBe(false)
    expect(canTransitionJob('closed', 'draft')).toBe(false)
    expect(canTransitionJob('active', 'active')).toBe(true) // no-op
  })
})

describe('pipeline state machine (docs/02 §0, docs/05 §4.3)', () => {
  it('walks the primary chain', () => {
    expect(nextPipelineStatus('new')).toBe('reviewing')
    expect(nextPipelineStatus('offered')).toBe('hired')
    expect(nextPipelineStatus('hired')).toBeNull()
    expect(nextPipelineStatus('rejected')).toBeNull()
  })
  it('restores the pre-archive status from timeline payloads', () => {
    const timeline = [
      { type: 'status_changed', payload: { from: 'new', to: 'reviewing' } },
      { type: 'status_changed', payload: { from: 'reviewing', to: 'archived' } },
      { type: 'application_created', payload: {} },
    ]
    expect(statusBeforeArchive(timeline)).toBe('reviewing')
  })
  it('falls back sensibly when no archive event exists', () => {
    expect(statusBeforeArchive([], 'reviewing')).toBe('reviewing')
  })
  it('rejects bogus statuses in PATCH input', () => {
    expect(() => UpdateApplicationInput.parse({ status: 'maybe' })).toThrow()
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-08-07T12:00:00Z')
  it('formats fresh and old timestamps', () => {
    expect(relativeTime('2026-08-07T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-08-07T11:55:00Z', now)).toBe('5m ago')
    expect(relativeTime('2026-08-07T05:00:00Z', now)).toBe('7h ago')
    expect(relativeTime('2026-08-01T12:00:00Z', now)).toBe('6d ago')
  })
})
