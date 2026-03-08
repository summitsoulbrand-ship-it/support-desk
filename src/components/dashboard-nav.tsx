'use client';

/**
 * Dashboard navigation sidebar - collapsible
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import {
  Inbox,
  Settings,
  Users,
  LogOut,
  Plug,
  Mail,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Workflow,
  MessageCircle,
  BarChart3,
  Star,
  Layers,
  AlertCircle,
  Globe,
} from 'lucide-react';

interface DashboardNavProps {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

export function DashboardNav({ user }: DashboardNavProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Persist collapsed state
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);

  // Auto-expand settings if on a settings sub-page
  useEffect(() => {
    const settingsPaths = ['/settings', '/admin/users', '/admin/mailbox', '/admin/social'];
    if (settingsPaths.some(p => pathname.startsWith(p))) {
      setSettingsExpanded(true);
    }
  }, [pathname]);

  const toggleCollapsed = () => {
    const newState = !collapsed;
    setCollapsed(newState);
    localStorage.setItem('sidebar-collapsed', String(newState));
  };

  const isAdmin = user.role === 'ADMIN';

  // Background sync with Printify every 30 minutes (only when tab is visible)
  const { data: lastSync } = useQuery({
    queryKey: ['printify-background-sync'],
    queryFn: async () => {
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: false, status: 'on-hold' }),
      });
      return Date.now();
    },
    enabled: isAdmin,
    refetchInterval: 30 * 60 * 1000, // Every 30 minutes
    refetchIntervalInBackground: false, // Only sync when tab is visible
    staleTime: 30 * 60 * 1000,
  });

  // Fetch count of orders ready to combine (for alert badge)
  // Refreshes when sync completes or when manually invalidated after actions
  const { data: combineData } = useQuery<{ customersWithMultiple: number }>({
    queryKey: ['orders-on-hold-count', lastSync],
    queryFn: async () => {
      const res = await fetch('/api/admin/printify/orders-on-hold');
      if (!res.ok) return { customersWithMultiple: 0 };
      return res.json();
    },
    enabled: isAdmin && lastSync !== undefined,
    staleTime: 30 * 60 * 1000, // Consider fresh for 30 minutes
  });

  const combineOrdersCount = combineData?.customersWithMultiple || 0;

  // Fetch count of international orders needing rerouting (for alert badge)
  // Refreshes when sync completes or when manually invalidated after actions
  const { data: internationalData } = useQuery<{ totalCount: number }>({
    queryKey: ['international-orders-count', lastSync],
    queryFn: async () => {
      const res = await fetch('/api/admin/printify/international-orders');
      if (!res.ok) return { totalCount: 0 };
      return res.json();
    },
    enabled: isAdmin && lastSync !== undefined,
    staleTime: 15 * 60 * 1000, // Consider fresh for 15 minutes (matches page sync interval)
  });

  const internationalOrdersCount = internationalData?.totalCount || 0;

  // Main navigation links
  const links = [
    {
      href: '/inbox',
      label: 'Email',
      icon: Inbox,
      show: true,
    },
    {
      href: '/admin/orders-on-hold',
      label: 'Combine Orders',
      icon: Layers,
      show: isAdmin,
      alertCount: combineOrdersCount,
    },
    {
      href: '/admin/international-orders',
      label: 'International',
      icon: Globe,
      show: isAdmin,
      alertCount: internationalOrdersCount,
    },
    {
      href: '/social',
      label: 'Social',
      icon: MessageCircle,
      show: true,
    },
    {
      href: '/reviews',
      label: 'Reviews',
      icon: Star,
      show: true,
    },
    {
      href: '/admin/integrations',
      label: 'Integrations',
      icon: Plug,
      show: isAdmin,
    },
    {
      href: '/admin/automation',
      label: 'Automation',
      icon: Workflow,
      show: isAdmin,
    },
    {
      href: '/admin/printify-insights',
      label: 'Printify Insights',
      icon: BarChart3,
      show: isAdmin,
    },
    {
      href: '/trash',
      label: 'Trash',
      icon: Trash2,
      show: true,
    },
  ];

  // Settings sub-navigation (expandable)
  const settingsLinks = [
    {
      href: '/settings',
      label: 'General',
      icon: Settings,
      show: true,
    },
    {
      href: '/admin/users',
      label: 'Users',
      icon: Users,
      show: isAdmin,
    },
    {
      href: '/admin/mailbox',
      label: 'Mailbox',
      icon: Mail,
      show: isAdmin,
    },
    {
      href: '/admin/social',
      label: 'Social',
      icon: MessageCircle,
      show: isAdmin,
    },
  ];

  return (
    <div
      className={cn(
        'bg-white border-r flex flex-col transition-all duration-200',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="p-4 border-b flex items-center justify-between">
        {!collapsed && (
          <h1 className="text-xl font-bold text-gray-900">Support Desk</h1>
        )}
        <button
          onClick={toggleCollapsed}
          className={cn(
            'p-1 rounded-lg hover:bg-gray-100 text-gray-500',
            collapsed && 'mx-auto'
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="w-5 h-5" />
          ) : (
            <ChevronLeft className="w-5 h-5" />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 overflow-y-auto">
        <ul className="space-y-1">
          {links
            .filter((link) => link.show)
            .map((link) => {
              const Icon = link.icon;
              const isActive = pathname.startsWith(link.href);
              const hasAlert = 'alertCount' in link && (link.alertCount as number) > 0;

              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors relative',
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-900 hover:bg-gray-100 hover:text-gray-900',
                      collapsed && 'justify-center px-2'
                    )}
                    title={collapsed ? link.label : undefined}
                  >
                    <div className="relative">
                      <Icon className="w-5 h-5 flex-shrink-0" />
                      {hasAlert && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full border border-white" />
                      )}
                    </div>
                    {!collapsed && (
                      <>
                        <span className="flex-1">{link.label}</span>
                        {hasAlert && (
                          <span className="flex items-center gap-1 text-xs text-red-600">
                            <AlertCircle className="w-3.5 h-3.5" />
                            {link.alertCount as number}
                          </span>
                        )}
                      </>
                    )}
                  </Link>
                </li>
              );
            })}

          {/* Settings Section */}
          <li>
            <button
              onClick={() => !collapsed && setSettingsExpanded(!settingsExpanded)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                settingsLinks.some(l => l.show && pathname.startsWith(l.href))
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-900 hover:bg-gray-100 hover:text-gray-900',
                collapsed && 'justify-center px-2'
              )}
              title={collapsed ? 'Settings' : undefined}
            >
              <Settings className="w-5 h-5 flex-shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Settings</span>
                  <ChevronDown
                    className={cn(
                      'w-4 h-4 transition-transform',
                      settingsExpanded && 'rotate-180'
                    )}
                  />
                </>
              )}
            </button>
            {!collapsed && settingsExpanded && (
              <ul className="mt-1 ml-4 space-y-1 border-l border-gray-200 pl-3">
                {settingsLinks
                  .filter((link) => link.show)
                  .map((link) => {
                    const Icon = link.icon;
                    const isActive = pathname === link.href ||
                      (link.href !== '/settings' && pathname.startsWith(link.href));

                    return (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors',
                            isActive
                              ? 'bg-blue-50 text-blue-700 font-medium'
                              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                          )}
                        >
                          <Icon className="w-4 h-4 flex-shrink-0" />
                          <span>{link.label}</span>
                        </Link>
                      </li>
                    );
                  })}
              </ul>
            )}
          </li>
        </ul>
      </nav>

      {/* User section */}
      <div className={cn('p-2 border-t', collapsed ? 'px-2' : 'p-4')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <Avatar name={user.name} size="md" />
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <Avatar name={user.name} size="md" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {user.name}
                </p>
                <p className="text-xs text-gray-500 truncate">{user.email}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => signOut({ callbackUrl: '/login' })}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign out
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
