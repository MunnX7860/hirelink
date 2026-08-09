import 'server-only'

import { logger, errorSummary } from '@/lib/logger'

/**
 * Resume text extraction — docs/10 §3 ("pdf-parse / mammoth", server-side).
 * Dynamic imports keep these parsers out of the main bundle; output is
 * whitespace-normalised and capped so `parsed_text` stays bounded.
 * `.doc` (legacy binary) is unsupported → null (graceful, surfaced by caller).
 */

export const PARSED_TEXT_CAP = 50_000

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PARSED_TEXT_CAP)
}

export async function extractResumeText(data: Buffer, mime: string): Promise<string | null> {
  try {
    if (mime === 'application/pdf') {
      // Direct lib path: the package index has a debug-mode branch that reads
      // test files when loaded bare (known pdf-parse@1 quirk).
      const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default
      const result = await pdf(data)
      const text = normalizeExtractedText(result.text ?? '')
      return text.length > 0 ? text : null
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: data })
      const text = normalizeExtractedText(result.value ?? '')
      return text.length > 0 ? text : null
    }
    // application/msword (.doc binary) — no safe pure-JS extractor; degrade (docs/10 §6).
    return null
  } catch (err) {
    // Extraction failure must never break the AI surface (graceful degradation).
    logger.warn('resume text extraction failed', { ...errorSummary(err) })
    return null
  }
}
