'use client'

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Toast } from '@/ui/toast'

/**
 * Toaster — docs/06 §3/§7: top-center on mobile, 4s auto-dismiss, optional Undo,
 * ONE toast per user action, max 2 queued. Deliberately a tiny custom queue —
 * Radix Toast's viewport model doesn't fit single-action feedback (CHANGELOG Phase 1).
 */

interface ToastItem {
  id: number
  message: ReactNode
  tone: 'info' | 'success' | 'danger'
  actionLabel?: string | undefined
  onAction?: (() => void) | undefined
}

interface ToastContextValue {
  toast: (
    message: ReactNode,
    options?: { tone?: ToastItem['tone']; actionLabel?: string; onAction?: () => void },
  ) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const toast = useCallback<ToastContextValue['toast']>((message, options) => {
    const id = nextId.current++
    setItems((prev) =>
      [
        ...prev,
        {
          id,
          message,
          tone: options?.tone ?? 'info',
          actionLabel: options?.actionLabel,
          onAction: options?.onAction,
        },
      ].slice(-2),
    )
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4_000)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <Toast
            key={t.id}
            tone={t.tone}
            action={
              t.actionLabel ? (
                <button
                  className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold underline underline-offset-2"
                  onClick={() => {
                    t.onAction?.()
                    setItems((prev) => prev.filter((x) => x.id !== t.id))
                  }}
                >
                  {t.actionLabel}
                </button>
              ) : undefined
            }
          >
            {t.message}
          </Toast>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue['toast'] {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx.toast
}
