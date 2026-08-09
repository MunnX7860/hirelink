import { Card } from '@/ui/card'
import { Skeleton } from '@/ui/skeleton'

/** Jobs list loading state — docs/06 §5. */
export default function JobsLoading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i} className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        </Card>
      ))}
    </div>
  )
}
