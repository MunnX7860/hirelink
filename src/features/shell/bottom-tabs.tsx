'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { IconInbox, IconBriefcase, IconUsers, IconSettings } from '@/ui/icons'

/**
 * Bottom tab bar (mobile) — docs/06 §4: Inbox · Jobs · People · Settings, ≤ 4 items.
 * At ≥ lg the shell switches to a left rail (same links).
 */
const tabs = [
  { href: '/dashboard', label: 'Inbox', icon: IconInbox, exact: true },
  { href: '/dashboard/jobs', label: 'Jobs', icon: IconBriefcase, exact: false },
  { href: '/dashboard/applicants', label: 'People', icon: IconUsers, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: IconSettings, exact: false },
] as const

export function BottomTabs() {
  const pathname = usePathname()

  function isActive(href: string, exact: boolean) {
    return exact ? pathname === href : pathname.startsWith(href)
  }

  return (
    <>
      {/* Mobile tab bar */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-200 bg-surface lg:hidden"
      >
        {tabs.map(({ href, label, icon: Icon, exact }) => {
          const active = isActive(href, exact)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium',
                active ? 'text-brand' : 'text-ink-secondary',
              )}
            >
              <Icon className="size-6" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Desktop rail */}
      <nav
        aria-label="Primary"
        className="fixed inset-y-14 left-0 z-10 hidden w-16 flex-col items-center gap-2 border-r border-slate-200 bg-surface py-4 lg:flex"
      >
        {tabs.map(({ href, label, icon: Icon, exact }) => {
          const active = isActive(href, exact)
          return (
            <Link
              key={href}
              href={href}
              title={label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex size-11 items-center justify-center rounded-lg',
                active ? 'bg-brand/10 text-brand' : 'text-ink-secondary hover:bg-slate-100',
              )}
            >
              <Icon className="size-6" />
            </Link>
          )
        })}
      </nav>
    </>
  )
}
