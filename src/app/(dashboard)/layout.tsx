/**
 * Dashboard layout - wraps authenticated pages
 */

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { DashboardNav } from '@/components/dashboard-nav';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <DashboardNav user={session.user} />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
