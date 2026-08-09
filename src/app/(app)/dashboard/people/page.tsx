import { redirect } from 'next/navigation'

/** Legacy Phase 0 stub route — the talent pool now lives at /dashboard/applicants (docs/06 §4). */
export default function PeopleRedirect() {
  redirect('/dashboard/applicants')
}
