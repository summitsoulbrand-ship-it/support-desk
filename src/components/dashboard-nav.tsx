'use client';

/**
 * Dashboard navigation sidebar - collapsible
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
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
  Tag,
  UserCheck,
  MessageCircle,
  BarChart3,
  Star,
  Layers,
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

  // Persist collapsed state
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    const newState = !collapsed;
    setCollapsed(newState);
    localStorage.setItem('sidebar-collapsed', String(newState));
  };

  const isAdmin = user.role === 'ADMIN';

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
      href: '/admin/users',
      label: 'Users',
      icon: Users,
      show: isAdmin,
    },
    {
      href: '/admin/integrations',
      label: 'Integrations',
      icon: Plug,
      show: isAdmin,
    },
    {
      href: '/admin/mailbox',
      label: 'Mailbox',
      icon: Mail,
      show: isAdmin,
    },
    {
      href: '/admin/tags',
      label: 'Tags',
      icon: Tag,
      show: isAdmin,
    },
    {
      href: '/admin/rules',
      label: 'Rules',
      icon: UserCheck,
      show: isAdmin,
    },
    {
      href: '/admin/social',
      label: 'Social Settings',
      icon: MessageCircle,
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
    {
      href: '/settings',
      label: 'Settings',
      icon: Settings,
      show: true,
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
      <nav className="flex-1 p-2">
        <ul className="space-y-1">
          {links
            .filter((link) => link.show)
            .map((link) => {
              const Icon = link.icon;
              const isActive = pathname.startsWith(link.href);

              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-900 hover:bg-gray-100 hover:text-gray-900',
                      collapsed && 'justify-center px-2'
                    )}
                    title={collapsed ? link.label : undefined}
                  >
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    {!collapsed && link.label}
                  </Link>
                </li>
              );
            })}
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
