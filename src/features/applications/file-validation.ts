import { AppError, ErrorCode } from '@/lib/errors'
import { RESUME_MAX_BYTES } from '@/features/applications/schemas'

/**
 * Resume file validation — docs/05 §5: MIME by MAGIC BYTES (never extension,
 * docs/03 §7), ≤10 MB. Pure + table-driven for testing (docs/13 §2).
 */

export type ResumeType = 'pdf' | 'doc' | 'docx'

export interface ValidatedResume {
  type: ResumeType
  mime: string
  sizeBytes: number
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] // legacy OLE (doc)

export function detectResumeType(buf: Buffer): ResumeType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf'
  if (buf.length >= 8 && CFB_MAGIC.every((b, i) => buf[i] === b)) return 'doc'
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
    return 'docx'
  return null
}

export function validateResumeFile(buf: Buffer): ValidatedResume {
  if (buf.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'The resume file is empty.')
  }
  if (buf.length > RESUME_MAX_BYTES) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE, 'Resume must be 10 MB or smaller.')
  }
  const type = detectResumeType(buf)
  if (!type) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, 'Resume must be a PDF, DOC or DOCX file.')
  }
  const mime =
    type === 'pdf'
      ? 'application/pdf'
      : type === 'doc'
        ? 'application/msword'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return { type, mime, sizeBytes: buf.length }
}

/** Docs/07 §4 filename shape: {Name}—{applicantId[:8]}—{safe filename}.ext */
export function buildResumeFilename(input: {
  applicantName: string
  applicantId: string
  originalName: string
  type: ResumeType
}): string {
  const safe = input.originalName
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/\.(pdf|docx?|)$/i, '')
  const person = input.applicantName
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return `${person}—${input.applicantId.slice(0, 8)}—${safe}.${input.type}`
}
