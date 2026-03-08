'use client';

/**
 * Automation page - Tags, Assignment Rules, and Inbox Filters in tabs
 */

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Tag, UserCheck, Trash2 } from 'lucide-react';

// Import the content from Tags and Rules pages as separate components
import TagsContent from './tags-content';
import AssignmentRulesContent from './assignment-rules-content';
import FiltersContent from './filters-content';

type Tab = 'tags' | 'assignment' | 'filters';

const TABS: { id: Tab; label: string; icon: typeof Tag }[] = [
  { id: 'tags', label: 'Tags', icon: Tag },
  { id: 'assignment', label: 'Assignment Rules', icon: UserCheck },
  { id: 'filters', label: 'Inbox Filters', icon: Trash2 },
];

export default function AutomationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('tags');

  // Sync tab with URL
  useEffect(() => {
    const tab = searchParams.get('tab') as Tab | null;
    if (tab && TABS.some(t => t.id === tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    router.replace(`/admin/automation?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Automation</h1>
        <p className="text-sm text-gray-600 mt-1">
          Configure tags, auto-assignment, and inbox filters
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  'flex items-center gap-2 pb-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'tags' && <TagsContent />}
      {activeTab === 'assignment' && <AssignmentRulesContent />}
      {activeTab === 'filters' && <FiltersContent />}
    </div>
  );
}
