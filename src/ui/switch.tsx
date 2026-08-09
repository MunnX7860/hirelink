'use client'

import * as RadixSwitch from '@radix-ui/react-switch'
import { forwardRef, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Switch — docs/06 §3. Wrapped Radix for a11y (keyboard + semantics). */
export const Switch = forwardRef<
  React.ElementRef<typeof RadixSwitch.Root>,
  ComponentProps<typeof RadixSwitch.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <RadixSwitch.Root
      ref={ref}
      className={cn(
        'relative h-7 w-12 cursor-pointer rounded-full bg-slate-300 transition-colors data-[state=checked]:bg-brand',
        'after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-white after:transition-transform',
        'data-[state=checked]:after:translate-x-5 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
})
