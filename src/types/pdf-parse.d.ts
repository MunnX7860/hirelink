/**
 * pdf-parse@1 ships no types for the direct lib-path import we use (bypassing
 * its debug-mode index.js — see lib/ai/extract.ts). Minimal surface we consume.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages: number
    numrender: number
    info: Record<string, unknown>
    metadata: unknown
    version: string
  }
  function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>
  export default pdfParse
}
