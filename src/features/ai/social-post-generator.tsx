'use client'

import { useState } from 'react'
import { Button } from '@/ui/button'
import { CopyButton } from '@/ui/copy-button'
import { ApiError, mutate } from '@/lib/api-client'
import { SOCIAL_PLATFORMS, SOCIAL_TONES } from '@/lib/ai/social-constants'
import type { SocialPlatform, SocialTone } from '@/lib/ai/social-constants'

/**
 * Social post generator — docs/10 §3 (tone + platform hint; ≤280 chars + link).
 * Explicit button action only; with AI not configured the control is visibly
 * disabled with an explainer (docs/10 §6).
 */
export function SocialPostGenerator({ jobId, aiEnabled }: { jobId: string; aiEnabled: boolean }) {
  const [tone, setTone] = useState<SocialTone>('friendly')
  const [platform, setPlatform] = useState<SocialPlatform>('whatsapp')
  const [result, setResult] = useState<{ post: string; link: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const res = await mutate<{ post: string; link: string }>(
        '/api/ai/generate/social-post',
        'POST',
        { job_id: jobId, tone, platform },
      )
      setResult(res)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t draft a post.')
    } finally {
      setBusy(false)
    }
  }

  if (!aiEnabled) {
    return (
      <p className="text-xs text-ink-secondary">
        Add a Gemini key in Settings → AI to generate a ready-to-post hiring blurb.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="sp-tone">
          Tone
        </label>
        <select
          id="sp-tone"
          value={tone}
          onChange={(e) => setTone(e.target.value as SocialTone)}
          className="h-10 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
        >
          {SOCIAL_TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sp-platform">
          Platform
        </label>
        <select
          id="sp-platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
          className="h-10 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
        >
          {SOCIAL_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busy}
          onClick={() => void generate()}
        >
          ✨ Generate post
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{result.post}</p>
          <p className="break-all text-xs text-ink-secondary">{result.link}</p>
          <div className="flex gap-2">
            <CopyButton text={`${result.post}\n${result.link}`} label="Copy post + link" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void generate()}
            >
              Regenerate
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
