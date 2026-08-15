import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Guards a real production outage: `WorkspaceSwitcher` and `WorkspaceChooserModal`
 * both call `useToast()`, and both first mount the moment a user gains their first
 * organization membership. The app shell used to wrap only `{children}` in
 * `<Providers>` (which supplies ToastProvider), leaving those two outside it — so
 * creating your first workspace threw "useToast must be used inside <ToastProvider>"
 * and 500'd every authenticated page. Shipped in v1.0.0, undetected until live use.
 *
 * This is a source-structure assertion rather than a render test on purpose: the
 * suite runs in `environment: 'node'` with no React Testing Library, and pulling
 * in jsdom + RTL for one invariant would cost the whole suite. It proves ordering,
 * not runtime behaviour — the honest limit of a static check.
 */

const LAYOUT = readFileSync(resolve(process.cwd(), 'src/app/(app)/layout.tsx'), 'utf8')

/** Client components in the shell that consume context from <Providers>. */
const CONTEXT_CONSUMERS = ['<WorkspaceSwitcher', '<WorkspaceChooserModal']

describe('authenticated app shell — provider scope', () => {
  it('wraps the whole shell in <Providers>, not just {children}', () => {
    const open = LAYOUT.indexOf('<Providers>')
    const close = LAYOUT.indexOf('</Providers>')
    expect(open, '<Providers> must be present in the app shell').toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)

    // The shell's root element must be INSIDE the provider, which is what
    // distinguishes "wraps everything" from the old "wraps only <main>".
    const shellRoot = LAYOUT.indexOf('<div className="flex min-h-dvh flex-col">')
    expect(shellRoot, 'shell root element not found — update this test').toBeGreaterThan(-1)
    expect(shellRoot).toBeGreaterThan(open)
    expect(shellRoot).toBeLessThan(close)
  })

  it.each(CONTEXT_CONSUMERS)('renders %s inside the provider boundary', (consumer) => {
    const open = LAYOUT.indexOf('<Providers>')
    const close = LAYOUT.indexOf('</Providers>')
    const at = LAYOUT.indexOf(consumer)
    expect(at, `${consumer} not found — update this test if the shell changed`).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(open)
    expect(at).toBeLessThan(close)
  })

  it('keeps the consumer list honest — every useToast caller in the shell is listed', () => {
    // If a new client component using useToast is added to the shell, it must be
    // added to CONTEXT_CONSUMERS above so the ordering assertion covers it too.
    const imported = [...LAYOUT.matchAll(/import \{ (\w+) \} from '@\/features\/[^']+'/g)].map(
      (m) => `<${m[1]}`,
    )
    const usesToast = imported.filter((tag) => {
      const name = tag.slice(1)
      const path = [
        `src/features/orgs/${kebab(name)}.tsx`,
        `src/features/shell/${kebab(name)}.tsx`,
        `src/features/auth/${kebab(name)}.tsx`,
      ].find(exists)
      return path ? readFileSync(resolve(process.cwd(), path), 'utf8').includes('useToast') : false
    })
    expect(usesToast.sort()).toEqual([...CONTEXT_CONSUMERS].sort())
  })
})

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function exists(path: string): boolean {
  try {
    readFileSync(resolve(process.cwd(), path))
    return true
  } catch {
    return false
  }
}
