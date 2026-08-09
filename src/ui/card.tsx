import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Card — docs/06 §2-3: white surface, 12px radius, subtle shadow, 16px padding (mobile). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[12px] bg-surface p-4 shadow-[0_1px_2px_rgb(15_23_42/0.06)] sm:p-6',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('mb-3 flex items-center justify-between gap-2', className)} {...props} />
  )
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-lg font-semibold text-ink', className)} {...props} />
}
