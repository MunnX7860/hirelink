import { Card } from '@/ui/card'
import { Skeleton } from '@/ui/skeleton'

/** Application detail loading state — docs/06 §5. */
export default function ApplicationDetailLoading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-5 w-24 rounded-full" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-full" />
        </Card>
      ))}
    </div>
  )
}
