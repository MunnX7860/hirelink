import { describe, it, expect } from 'vitest'
import { renderEmail } from '@/emails/registry'
import { sanitizeDriveName } from '@/lib/storage/google-drive'

/** Email registry — docs/09 §6 (snapshot-style content assertions + plaintext). */
describe('email registry (docs/09 §2)', () => {
  it('application_received renders subject, html and plaintext with ctx', async () => {
    const { subject, html, text } = await renderEmail('application_received', {
      candidateFirstName: 'Asha',
      jobTitle: 'Barista',
      companyLabel: 'Blue Tokai Café',
    })
    expect(subject).toBe('Application received — Barista')
    expect(html).toContain('Barista')
    expect(html).toContain('Asha')
    expect(html).toContain('Blue Tokai Café')
    expect(text).toContain('Barista')
    expect(text.length).toBeGreaterThan(20)
  })

  it('owner_resume_failed includes job + applicant + settings link', async () => {
    const { subject, html } = await renderEmail('owner_resume_failed', {
      jobTitle: 'Chef',
      applicantName: 'Raj Kumar',
      settingsUrl: 'http://localhost:3000/dashboard/settings',
    })
    expect(subject).toContain('Chef')
    expect(html).toContain('Raj Kumar')
    expect(html).toContain('/dashboard/settings')
  })
})

describe('Drive name sanitiser (docs/07 §4)', () => {
  it('strips illegal chars and truncates', () => {
    expect(sanitizeDriveName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    const long = sanitizeDriveName('x'.repeat(200))
    expect(long.length).toBeLessThanOrEqual(80)
  })
})
