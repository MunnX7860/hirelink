import { describe, it, expect } from 'vitest'
import {
  escapeMarkdownV2,
  buildNewApplicationMessage,
  buildResumeFailedMessage,
} from '@/lib/notifications/telegram'
import type { NewApplicationEvent } from '@/lib/notifications/types'

/** Telegram template + escaper — docs/08 §6 mandates these table tests. */
describe('escapeMarkdownV2 (docs/08 §2)', () => {
  const RESERVED = '_*[]()~`>#+-=|{}.!'.split('')
  for (const ch of RESERVED) {
    it(`escapes "${ch}"`, () => {
      expect(escapeMarkdownV2(`a${ch}b`)).toBe(`a\\${ch}b`)
    })
  }
  it('leaves normal text untouched', () => {
    expect(escapeMarkdownV2('Asha Verma, 3y exp')).toBe('Asha Verma, 3y exp')
  })
})

const EVENT: NewApplicationEvent = {
  jobTitle: 'Barista (Weekend!)',
  applicantName: 'Asha [Star] Verma',
  email: 'asha@example.com',
  phone: null,
  resumeUploaded: true,
  applicationId: '11111111-2222-3333-4444-555555555555',
}

describe('buildNewApplicationMessage (docs/08 §2 template)', () => {
  it('includes escaped user content, resume state and the dashboard deep-link button', () => {
    const { text, replyMarkup } = buildNewApplicationMessage(EVENT)
    expect(text).toContain('Barista \\(Weekend\\!\\)')
    expect(text).toContain('Asha \\[Star\\] Verma')
    expect(text).toContain('asha@example\\.com') // MarkdownV2 escapes the dots
    expect(text).toContain('📞 —')
    expect(text).toContain('attached ✔')
    const url = replyMarkup.inline_keyboard[0]?.[0]?.url ?? ''
    expect(url).toMatch(/\/dashboard\/applications\/11111111-2222-3333-4444-555555555555$/)
  })

  it('marks failed uploads with the ⚠ variant', () => {
    const { text } = buildNewApplicationMessage({ ...EVENT, resumeUploaded: false })
    expect(text).toContain('upload failed ⚠')
  })
})

describe('buildResumeFailedMessage', () => {
  it('escapes job + applicant and explains next steps', () => {
    const text = buildResumeFailedMessage({ jobTitle: 'Chef — Night! (2)', applicantName: 'Raj.K' })
    expect(text).toContain('Chef — Night\\! \\(2\\)')
    expect(text).toContain('Raj\\.K')
    expect(text).toContain('Google Drive')
  })
})
