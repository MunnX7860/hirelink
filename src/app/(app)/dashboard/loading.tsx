import { Card } from '@/ui/card'
import { Skeleton } from '@/ui/skeleton'

/** Inbox loading state — docs/06 §5: skeleton matching the final card list, no spinner. */
export default function InboxLoading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4 pb-24">
      <Skeleton className="h-7 w-24" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i} className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        </Card>
      ))}
    </div>
  )
}
