import { describe, expect, it } from 'vitest'
import { __testables } from '@/lib/notifications/gmail'

const { buildRawMessage, encodeHeaderWord, sanitizeHeader } = __testables

/**
 * The Gmail transport assembles raw RFC 5322 itself, unlike the Resend and
 * nodemailer paths which hand structured fields to a library. That makes header
 * assembly the one genuinely dangerous part: an org display name or job title
 * containing a newline would otherwise inject arbitrary headers.
 */
describe('gmail header assembly (docs/09 §1)', () => {
  it('strips CR/LF so a display name cannot inject headers', () => {
    expect(sanitizeHeader('Acme\r\nBcc: attacker@evil.com')).toBe('Acme Bcc: attacker@evil.com')
    expect(sanitizeHeader('Acme\nX-Evil: 1')).toBe('Acme X-Evil: 1')
    expect(sanitizeHeader('  padded  ')).toBe('padded')
  })

  it('leaves printable ASCII alone and encodes anything else', () => {
    expect(encodeHeaderWord('Application received - Barista')).toBe(
      'Application received - Barista',
    )
    // Non-ASCII must not reach the wire raw, or clients render mojibake.
    const encoded = encodeHeaderWord('Café Münch')
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true)
    expect(encoded.endsWith('?=')).toBe(true)
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe('Café Münch')
  })

  it('no injected header survives into the built message', () => {
    const raw = buildRawMessage({
      from: '"Evil\r\nBcc: attacker@evil.com" <owner@gmail.com>',
      to: 'candidate@example.com',
      subject: 'Hi\r\nX-Injected: yes',
      html: '<p>hello</p>',
      text: 'hello',
    })
    // The payload text still appears — flattened onto the header it came from,
    // which is harmless. What must NOT happen is a new header line starting
    // with it, so assert on line structure rather than substring presence.
    const headerLines = raw.split('\r\n')
    expect(headerLines.some((l) => l.startsWith('Bcc:'))).toBe(false)
    expect(headerLines.some((l) => l.startsWith('X-Injected'))).toBe(false)
    expect(raw).toContain('Subject: Hi X-Injected: yes')
  })

  it('emits both plaintext and html legs, base64 encoded', () => {
    const raw = buildRawMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'S',
      html: '<p>hi</p>',
      text: 'hi',
    })
    expect(raw).toContain('Content-Type: multipart/alternative')
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"')
    expect(raw).toContain(Buffer.from('hi', 'utf8').toString('base64'))
    expect(raw).toContain(Buffer.from('<p>hi</p>', 'utf8').toString('base64'))
    // Closing delimiter must carry the trailing "--" or clients see a truncated body.
    expect(raw.trimEnd().endsWith('--')).toBe(true)
  })

  it('uses CRLF line endings throughout (bare LF breaks strict MTAs)', () => {
    const raw = buildRawMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'S',
      html: '<p>x</p>',
      text: 'x',
    })
    expect(
      raw.split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r')),
    ).toBe(true)
  })
})
