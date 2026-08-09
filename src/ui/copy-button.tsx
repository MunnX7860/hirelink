'use client'

import { useState } from 'react'
import { Button } from '@/ui/button'

/**
 * CopyButton — docs/06 §3: "Copied ✓" feedback on the button itself.
 * Used for hiring links (docs/02 §3).
 */
export function CopyButton({
  text,
  label = 'Copy link',
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for older mobile browsers.
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      el.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2_000)
  }

  return (
    <Button onClick={copy} className={className} aria-live="polite">
      {copied ? 'Copied ✓' : label}
    </Button>
  )
}
