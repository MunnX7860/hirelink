import { Card } from '@/ui/card'
import { Skeleton } from '@/ui/skeleton'

/** Talent pool loading state — docs/06 §5. */
export default function ApplicantsLoading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <Skeleton className="h-11 w-full rounded-lg" />
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </Card>
      ))}
    </div>
  )
}
