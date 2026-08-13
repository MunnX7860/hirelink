import { describe, it, expect } from 'vitest'
import {
  detectResumeType,
  validateResumeFile,
  buildResumeFilename,
} from '@/features/applications/file-validation'
import { AppError } from '@/lib/errors'
import { RESUME_MAX_BYTES } from '@/features/applications/constants'

/** Magic-byte resume validation — docs/05 §5, docs/13 §2. */
describe('resume magic-byte detection (docs/05 §5)', () => {
  it('detects PDF by %PDF- header', () => {
    expect(detectResumeType(Buffer.from('%PDF-1.7\n…'))).toBe('pdf')
  })
  it('detects DOC by CFB/OLE header', () => {
    expect(
      detectResumeType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00])),
    ).toBe('doc')
  })
  it('detects DOCX by PK zip header', () => {
    expect(detectResumeType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('docx')
  })
  it('rejects executables / random bytes / text (.txt renamed to .pdf)', () => {
    expect(detectResumeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull() // MZ exe
    expect(detectResumeType(Buffer.from('Just a plain text resume, honestly'))).toBeNull()
    expect(detectResumeType(Buffer.alloc(0))).toBeNull()
  })
})

describe('validateResumeFile errors map to docs/05 §2 codes', () => {
  it('413 FILE_TOO_LARGE beyond 10 MB', () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(RESUME_MAX_BYTES)])
    try {
      validateResumeFile(big)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('FILE_TOO_LARGE')
    }
  })
  it('415 UNSUPPORTED_FILE_TYPE for non-resume bytes', () => {
    try {
      validateResumeFile(Buffer.from('<html><body>not a resume</body></html>'))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('UNSUPPORTED_FILE_TYPE')
    }
  })
  it('valid pdf passes with mime + size', () => {
    const out = validateResumeFile(Buffer.from('%PDF-1.7 test payload'))
    expect(out.type).toBe('pdf')
    expect(out.mime).toBe('application/pdf')
    expect(out.sizeBytes).toBeGreaterThan(0)
  })
})

describe('buildResumeFilename (docs/07 §4 layout)', () => {
  it('follows {Name}—{file}.format and sanitizes', () => {
    const name = buildResumeFilename({
      applicantName: 'Asha/Verma: Star',
      originalName: 'My Resume (final).pdf',
      type: 'pdf',
    })
    expect(name).toBe('Asha Verma Star—My Resume (final).pdf')
    expect(name).not.toMatch(/[/\\:*?"<>|]/)
  })

  it('carries no applicant id — same person+file always yields the same name', () => {
    const args = { applicantName: 'Asha Verma', originalName: 'cv.pdf', type: 'pdf' as const }
    expect(buildResumeFilename(args)).toBe('Asha Verma—cv.pdf')
    // Documents the accepted trade-off (07 §4): names are cosmetic, ids are identity.
    expect(buildResumeFilename(args)).toBe(buildResumeFilename(args))
  })
})
