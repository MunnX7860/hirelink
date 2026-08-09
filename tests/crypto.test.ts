import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret, maskSecret } from '@/lib/crypto'

describe('crypto — AES-256-GCM credentials at rest (docs/07 §3)', () => {
  it('round-trips a secret', () => {
    const secret = 'dummy-refresh-token-1/abc._-~='
    const encrypted = encryptSecret(secret)
    expect(decryptSecret(encrypted)).toBe(secret)
  })

  it('uses the v1.<iv>.<tag>.<ct> format and a random IV (no two ciphertexts equal)', () => {
    const a = encryptSecret('same-input')
    const b = encryptSecret('same-input')
    expect(a).not.toBe(b)
    const parts = a.split('.')
    expect(parts[0]).toBe('v1')
    expect(parts).toHaveLength(4)
  })

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const encrypted = encryptSecret('sensitive')
    const parts = encrypted.split('.')
    const ct = Buffer.from(parts[3]!, 'base64url')
    ct[0] = ct[0]! ^ 0xff // flip a bit
    parts[3] = ct.toString('base64url')
    expect(() => decryptSecret(parts.join('.'))).toThrow()
  })

  it('rejects unknown payload formats', () => {
    expect(() => decryptSecret('not-a-payload')).toThrow('unrecognized')
    expect(() => decryptSecret('v2.x.y.z')).toThrow('unrecognized')
  })

  it('masks secrets for display without leaking content', () => {
    expect(maskSecret('abcdef123456')).toBe('…3456')
    expect(maskSecret('abc')).toBe('…')
  })
})
