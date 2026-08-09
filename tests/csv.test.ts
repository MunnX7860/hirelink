import { describe, expect, it } from 'vitest'
import { csvDocument, csvField, csvFilename } from '@/lib/csv'

describe('csvField', () => {
  it('passes plain values through untouched', () => {
    expect(csvField('Ada Lovelace')).toBe('Ada Lovelace')
    expect(csvField(42)).toBe('42')
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })

  it('quotes fields containing comma, quote, or newline (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField('cr\rlf')).toBe('"cr\rlf"')
  })

  it('guards spreadsheet formula injection with a leading tab', () => {
    expect(csvField('=1+1')).toBe('\t=1+1')
    expect(csvField('+cmd')).toBe('\t+cmd')
    expect(csvField('-10')).toBe('\t-10')
    expect(csvField('@x')).toBe('\t@x')
    // …and the tab-prefixed value is then quoted because it now contains no special CSV char? no — tab is fine unquoted
    expect(csvField('=SUM(A1:A2),x')).toBe('"\t=SUM(A1:A2),x"')
  })
})

describe('csvRow/csvDocument', () => {
  it('joins with commas and terminates lines with CRLF', () => {
    const doc = csvDocument(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', 'x,y'],
      ],
    )
    expect(doc).toBe('a,b\r\n1,2\r\n3,"x,y"\r\n')
  })
})

describe('csvFilename', () => {
  it('is kebab-case ASCII with a date suffix', () => {
    expect(csvFilename('HireLink Applicants!', new Date('2026-08-08T10:00:00Z'))).toBe(
      'hirelink-applicants-2026-08-08.csv',
    )
    expect(csvFilename('***', new Date('2026-08-08T00:00:00Z'))).toBe('export-2026-08-08.csv')
  })
})
