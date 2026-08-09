import { cn } from '@/lib/utils'
import type { TagRow } from '@/features/applicants/schemas'

/** TagChip — docs/06 §3 colored, removable chip; text always present (never color-only). */
export function TagChip({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<TagRow, 'name' | 'color'>
  onRemove?: (() => void) | undefined
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
        className,
      )}
      style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
    >
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove tag ${tag.name}`}
          className="-mr-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-black/10"
        >
          ×
        </button>
      ) : null}
    </span>
  )
}
