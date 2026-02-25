'use client';

/**
 * Social Comments Filters Component
 */

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Search, X, Facebook, Instagram, Filter } from 'lucide-react';

export interface SocialFilterState {
  platforms: string[];
  accountIds: string[];
  status: string[];
  hidden: boolean | undefined;
  hasReply: boolean | undefined;
  isAd: boolean | undefined;
  search: string;
}

interface SocialFiltersProps {
  filters: SocialFilterState;
  onChange: (filters: SocialFilterState) => void;
  accounts: Array<{
    id: string;
    name: string;
    platform: string;
    profilePictureUrl?: string | null;
  }>;
}

export function SocialFilters({ filters, onChange, accounts }: SocialFiltersProps) {
  const updateFilter = <K extends keyof SocialFiltersProps['filters']>(
    key: K,
    value: SocialFiltersProps['filters'][K]
  ) => {
    onChange({ ...filters, [key]: value });
  };

  const togglePlatform = (platform: string) => {
    const current = filters.platforms;
    if (current.includes(platform)) {
      updateFilter('platforms', current.filter((p) => p !== platform));
    } else {
      updateFilter('platforms', [...current, platform]);
    }
  };

  const toggleStatus = (status: string) => {
    const current = filters.status;
    if (current.includes(status)) {
      updateFilter('status', current.filter((s) => s !== status));
    } else {
      updateFilter('status', [...current, status]);
    }
  };

  const toggleAccount = (accountId: string) => {
    const current = filters.accountIds;
    if (current.includes(accountId)) {
      updateFilter('accountIds', current.filter((a) => a !== accountId));
    } else {
      updateFilter('accountIds', [...current, accountId]);
    }
  };

  const clearFilters = () => {
    onChange({
      platforms: [],
      accountIds: [],
      status: [],
      hidden: undefined,
      hasReply: undefined,
      isAd: undefined,
      search: '',
    });
  };

  const hasActiveFilters =
    filters.platforms.length > 0 ||
    filters.accountIds.length > 0 ||
    filters.status.length > 0 ||
    filters.hidden !== undefined ||
    filters.hasReply !== undefined ||
    filters.isAd !== undefined ||
    filters.search.length > 0;

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          type="text"
          placeholder="Search comments..."
          value={filters.search}
          onChange={(e) => updateFilter('search', e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Platform filters */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => togglePlatform('FACEBOOK')}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              filters.platforms.includes('FACEBOOK')
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            <Facebook className="w-3.5 h-3.5" />
            Facebook
          </button>
          <button
            onClick={() => togglePlatform('INSTAGRAM')}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              filters.platforms.includes('INSTAGRAM')
                ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            <Instagram className="w-3.5 h-3.5" />
            Instagram
          </button>
        </div>

        <div className="w-px h-4 bg-gray-200" />

        {/* Status filters */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => toggleStatus('NEW')}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              filters.status.includes('NEW')
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            New
          </button>
          <button
            onClick={() => toggleStatus('IN_PROGRESS')}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              filters.status.includes('IN_PROGRESS')
                ? 'bg-yellow-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            In Progress
          </button>
          <button
            onClick={() => toggleStatus('DONE')}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              filters.status.includes('DONE')
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            Done
          </button>
        </div>

        <div className="w-px h-4 bg-gray-200" />

        {/* Additional filters */}
        <button
          onClick={() => updateFilter('hidden', filters.hidden === true ? undefined : true)}
          className={cn(
            'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
            filters.hidden === true
              ? 'bg-gray-700 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          )}
        >
          Hidden
        </button>
        <button
          onClick={() => updateFilter('hasReply', filters.hasReply === false ? undefined : false)}
          className={cn(
            'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
            filters.hasReply === false
              ? 'bg-orange-500 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          )}
        >
          No Reply
        </button>
        <button
          onClick={() => updateFilter('isAd', filters.isAd === true ? undefined : true)}
          className={cn(
            'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
            filters.isAd === true
              ? 'bg-purple-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          )}
        >
          Ads Only
        </button>

        {/* Clear filters */}
        {hasActiveFilters && (
          <>
            <div className="w-px h-4 bg-gray-200" />
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              <X className="w-3 h-3" />
              Clear
            </button>
          </>
        )}
      </div>

      {/* Account selector (if multiple accounts) */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 flex items-center gap-1">
            <Filter className="w-3 h-3" />
            Accounts:
          </span>
          {accounts.map((account) => (
            <button
              key={account.id}
              onClick={() => toggleAccount(account.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                filters.accountIds.includes(account.id)
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              )}
            >
              {account.profilePictureUrl && (
                <img
                  src={account.profilePictureUrl}
                  alt=""
                  className="w-4 h-4 rounded-full"
                />
              )}
              {account.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
