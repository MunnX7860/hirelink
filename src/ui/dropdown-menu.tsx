'use client'

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Dropdown menu — docs/06 §3 overflow/secondary actions. Radix for keyboard nav. */
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-44 rounded-[12px] border border-slate-200 bg-surface p-1 shadow-lg"
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

export function DropdownItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-ink outline-none',
        'data-[highlighted]:bg-slate-100',
        className,
      )}
      {...props}
    />
  )
}
