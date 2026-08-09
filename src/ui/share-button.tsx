'use client'

import { useState } from 'react'
import { Button } from '@/ui/button'

/**
 * ShareButton — docs/02 §3: native share sheet on mobile, clipboard fallback.
 */
export function ShareButton({ url, title }: { url: string; title: string }) {
  const [shared, setShared] = useState(false)

  async function share() {
    const payload = {
      title: `We're hiring: ${title}`,
      text: `We're hiring: ${title}. Apply here:`,
      url,
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(payload)
        return
      } catch {
        // user dismissed the sheet — nothing to do
        return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setShared(true)
      setTimeout(() => setShared(false), 2_000)
    } catch {
      // clipboard unavailable — link is still visible/copyable next to this button
    }
  }

  return (
    <Button variant="secondary" onClick={share}>
      {shared ? 'Copied ✓' : 'Share…'}
    </Button>
  )
}
