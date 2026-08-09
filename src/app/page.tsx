import { redirect } from 'next/navigation'

/** Root → dashboard (middleware sends unauthenticated users to /login). */
export default function Home() {
  redirect('/dashboard')
}
