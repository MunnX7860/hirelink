/**
 * CSV serialization for owner data exports — docs/05 §4.4 export.csv.
 * RFC-4180-ish: quote fields containing [",\n\r], double embedded quotes.
 * Formula-injection guard: prefix leading = + - @ with a tab (Excel hardening).
 */

const FORMULA_PREFIX = /^[=+\-@]/

export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (FORMULA_PREFIX.test(s)) s = `\t${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvRow(
  fields: ReadonlyArray<string | number | boolean | null | undefined>,
): string {
  return fields.map(csvField).join(',')
}

export function csvDocument(
  header: ReadonlyArray<string>,
  rows: Iterable<ReadonlyArray<string | number | boolean | null | undefined>>,
): string {
  const lines: string[] = [csvRow(header)]
  for (const row of rows) lines.push(csvRow(row))
  // \r\n per RFC 4180 §2.1; trailing newline so `wc -l` and Excel agree.
  return lines.join('\r\n') + '\r\n'
}

/** Safe attachment filename: ascii, kebab, no path traversal (docs/05 §4.4). */
export function csvFilename(base: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10)
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${clean || 'export'}-${day}.csv`
}
