import { Card } from '@/ui/card'
import { Skeleton } from '@/ui/skeleton'

/** Job detail loading state — docs/06 §5. */
export default function JobDetailLoading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <Skeleton className="h-7 w-2/3" />
      <Card className="flex gap-4">
        <Skeleton className="h-12 flex-1" />
        <Skeleton className="h-12 flex-1" />
        <Skeleton className="h-12 flex-1" />
      </Card>
      <Skeleton className="h-5 w-32" />
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </Card>
      ))}
    </div>
  )
}
