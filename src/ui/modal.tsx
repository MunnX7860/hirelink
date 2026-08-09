'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { type ReactNode } from 'react'
import { Button } from '@/ui/button'
import { cn } from '@/lib/utils'

/**
 * Modal — docs/06 §3: CONFIRMS ONLY (destructive actions). Radix Dialog for
 * focus trap + Escape + scroll lock (docs/06 §6 a11y).
 */
export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  loading = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel?: string
  destructive?: boolean
  loading?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2',
            'rounded-[12px] bg-surface p-6 shadow-xl',
          )}
        >
          <Dialog.Title className="text-lg font-semibold text-ink">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-2 text-sm text-ink-secondary">
              {description}
            </Dialog.Description>
          ) : null}
          <div className="mt-6 flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              className="flex-1"
              loading={loading}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
