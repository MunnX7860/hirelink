import { Skeleton } from '@/ui/skeleton'

/** Pipeline board loading state — docs/06 §5: column layout, not a spinner. */
export default function PipelineLoading() {
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {Array.from({ length: 5 }).map((_, col) => (
        <div key={col} className="flex w-64 shrink-0 flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: 3 }).map((_, card) => (
            <Skeleton key={card} className="h-20 w-full rounded-[12px]" />
          ))}
        </div>
      ))}
    </div>
  )
}
