'use client';

/**
 * Social Comments List Component
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatDistanceToNow } from 'date-fns';
import {
  Facebook,
  Instagram,
  Eye,
  EyeOff,
  MessageCircle,
  ThumbsUp,
  Megaphone,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Check,
  Lightbulb,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface SocialCommentListProps {
  filters: {
    platforms: string[];
    accountIds: string[];
    status: string[];
    hidden?: boolean;
    hasReply?: boolean;
    isAd?: boolean;
    search: string;
  };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function SocialCommentList({
  filters,
  selectedId,
  onSelect,
}: SocialCommentListProps) {
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  // Save a comment as a design idea straight from the list
  const [ideaSavedIds, setIdeaSavedIds] = useState<Set<string>>(new Set());
  const ideaMutation = useMutation({
    mutationFn: async (c: {
      id: string;
      message: string;
      authorName: string;
      permalink?: string | null;
      platform: string;
    }) => {
      const res = await fetch('/api/design-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: c.message,
          source: c.platform === 'INSTAGRAM' ? 'INSTAGRAM' : 'FACEBOOK',
          authorName: c.authorName,
          permalink: c.permalink || undefined,
          sourceId: c.id,
        }),
      });
      if (!res.ok) throw new Error('Failed to save idea');
      return res.json();
    },
    onSuccess: (_d, c) => {
      setIdeaSavedIds((prev) => new Set(prev).add(c.id));
    },
  });

  // Quick "done" straight from the list - no need to open the comment
  const doneMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/social/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      });
      if (!res.ok) throw new Error('Failed to mark done');
      return res.json();
    },
    // Flip the row to DONE instantly so it drops out of the Open tab without
    // waiting for the PATCH + refetch. Snapshot for rollback on failure.
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ['social-comments'] });
      const snapshots = queryClient.getQueriesData<{
        comments?: Array<{ id: string; status: string }>;
      }>({ queryKey: ['social-comments'] });
      for (const [key, data] of snapshots) {
        if (!data?.comments) continue;
        // The list renders the whole array (status filtering is the server query
        // param), so drop the row from any view that excludes DONE; keep+mark it
        // only where DONE is shown.
        const statusParam = new URLSearchParams(String((key as unknown[])[1] ?? '')).get('status');
        const hideFromView = statusParam != null && !statusParam.split(',').includes('DONE');
        queryClient.setQueryData(key, {
          ...data,
          comments: hideFromView
            ? data.comments.filter((c) => c.id !== id)
            : data.comments.map((c) => (c.id === id ? { ...c, status: 'DONE' } : c)),
        });
      }
      return { snapshots };
    },
    onError: (_err, _id, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['social-comments'] });
      queryClient.invalidateQueries({ queryKey: ['social-comment-counts'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });
  const limit = 25;

  // Debounced so typing in the search box doesn't fire a fetch per keystroke
  const debouncedSearch = useDebouncedValue(filters.search, 300);

  // Build query params
  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('limit', String(limit));

  if (filters.platforms.length > 0) {
    queryParams.set('platforms', filters.platforms.join(','));
  }
  if (filters.accountIds.length > 0) {
    queryParams.set('accountIds', filters.accountIds.join(','));
  }
  if (filters.status.length > 0) {
    queryParams.set('status', filters.status.join(','));
  }
  if (filters.hidden !== undefined) {
    queryParams.set('hidden', String(filters.hidden));
  }
  if (filters.hasReply !== undefined) {
    queryParams.set('hasReply', String(filters.hasReply));
  }
  if (filters.isAd !== undefined) {
    queryParams.set('isAd', String(filters.isAd));
  }
  if (debouncedSearch) {
    queryParams.set('search', debouncedSearch);
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['social-comments', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/social/comments?${queryParams}`);
      if (!res.ok) throw new Error('Failed to fetch comments');
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    // Keep the previous list on screen while a new search loads
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm">
        Failed to load comments
      </div>
    );
  }

  const comments = data?.comments || [];
  const pagination = data?.pagination || { page: 1, totalPages: 1, total: 0 };

  if (comments.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm p-4 text-center">
        <div>
          <MessageCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p>No comments found</p>
          {Object.values(filters).some((v) =>
            Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ''
          ) && (
            <p className="text-xs mt-1">Try adjusting your filters</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {comments.map((comment: any) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            isSelected={comment.id === selectedId}
            onClick={() => onSelect(comment.id)}
            onMarkDone={
              comment.status !== 'DONE'
                ? () => doneMutation.mutate(comment.id)
                : undefined
            }
            onSaveIdea={() => ideaMutation.mutate(comment)}
            ideaSaved={ideaSavedIds.has(comment.id)}
          />
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="border-t px-3 py-2 flex items-center justify-between text-sm">
          <span className="text-gray-500">
            {pagination.total} comments
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="px-2">
              {page} / {pagination.totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page === pagination.totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface CommentRowProps {
  comment: {
    id: string;
    platform: string;
    category?: string | null;
    permalink?: string | null;
    authorName: string;
    authorProfileUrl?: string | null;
    message: string;
    hidden: boolean;
    status: string;
    likeCount: number;
    replyCount: number;
    hasPageReply: boolean;
    commentedAt: string;
    object: {
      type: string;
      adId?: string | null;
      thumbnailUrl?: string | null;
    };
    account: {
      name: string;
    };
  };
  isSelected: boolean;
  onClick: () => void;
  onMarkDone?: () => void;
  onSaveIdea?: () => void;
  ideaSaved?: boolean;
}

function CommentRow({ comment, isSelected, onClick, onMarkDone, onSaveIdea, ideaSaved }: CommentRowProps) {
  const PlatformIcon = comment.platform === 'FACEBOOK' ? Facebook : Instagram;
  const isAd = comment.object.adId != null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 border-b transition-colors',
        isSelected
          ? 'bg-blue-50 border-l-2 border-l-blue-500'
          : 'hover:bg-gray-50',
        comment.hidden && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Platform icon / Author avatar */}
        <div className="relative flex-shrink-0">
          {comment.authorProfileUrl ? (
            <img
              src={comment.authorProfileUrl}
              alt={comment.authorName}
              className="w-10 h-10 rounded-full"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
              <span className="text-sm font-medium text-gray-600">
                {comment.authorName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div
            className={cn(
              'absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center',
              comment.platform === 'FACEBOOK' ? 'bg-blue-600' : 'bg-gradient-to-br from-purple-500 to-pink-500'
            )}
          >
            <PlatformIcon className="w-3 h-3 text-white" />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-gray-900 truncate">
              {comment.authorName}
            </span>
            {isAd && (
              <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700">
                <Megaphone className="w-3 h-3" />
                Ad
              </span>
            )}
            {comment.hidden && (
              <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                <EyeOff className="w-3 h-3" />
                Hidden
              </span>
            )}
            {comment.category === 'COMPLAINT' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">
                Issue
              </span>
            )}
            {comment.category === 'ORDER' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-700">
                Order
              </span>
            )}
            {comment.category === 'QUESTION' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
                Question
              </span>
            )}
            {comment.category === 'TAG' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                Tag
              </span>
            )}
          </div>

          <p className="text-sm text-gray-600 line-clamp-2">{comment.message}</p>

          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
            <span>
              {formatDistanceToNow(new Date(comment.commentedAt), { addSuffix: true })}
            </span>
            {comment.likeCount > 0 && (
              <span className="flex items-center gap-1">
                <ThumbsUp className="w-3 h-3" />
                {comment.likeCount}
              </span>
            )}
            {comment.replyCount > 0 && (
              <span className="flex items-center gap-1">
                <MessageCircle className="w-3 h-3" />
                {comment.replyCount}
              </span>
            )}
            {comment.hasPageReply && (
              <span className="text-green-600 font-medium">Replied</span>
            )}
          </div>
        </div>

        {/* Right rail: ad preview, quick-done, status */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {comment.object.thumbnailUrl && (
            <img
              src={comment.object.thumbnailUrl}
              alt="Ad preview"
              className="w-11 h-11 rounded object-cover border border-gray-200"
            />
          )}
          <div className="flex items-center gap-1.5">
            {onSaveIdea && (
              <span
                role="button"
                title="Save as a customer design idea"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!ideaSaved) onSaveIdea();
                }}
                className={
                  ideaSaved
                    ? 'p-1 rounded-full text-amber-500 cursor-default'
                    : 'p-1 rounded-full text-gray-400 hover:text-amber-600 hover:bg-amber-50 cursor-pointer'
                }
              >
                <Lightbulb className="w-4 h-4" />
              </span>
            )}
            {onMarkDone && (
              <span
                role="button"
                title="Mark done without replying"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkDone();
                }}
                className="p-1 rounded-full text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
              </span>
            )}
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                comment.status === 'NEW' && 'bg-blue-500',
                comment.status === 'IN_PROGRESS' && 'bg-yellow-500',
                comment.status === 'DONE' && 'bg-green-500',
                comment.status === 'ESCALATED' && 'bg-red-500'
              )}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
