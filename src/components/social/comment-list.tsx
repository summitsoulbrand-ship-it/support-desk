'use client';

/**
 * Social Comments List Component
 */

import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
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
  const limit = 25;

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
  if (filters.search) {
    queryParams.set('search', filters.search);
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['social-comments', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/social/comments?${queryParams}`);
      if (!res.ok) throw new Error('Failed to fetch comments');
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
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
    };
    account: {
      name: string;
    };
  };
  isSelected: boolean;
  onClick: () => void;
}

function CommentRow({ comment, isSelected, onClick }: CommentRowProps) {
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

        {/* Status indicator */}
        <div
          className={cn(
            'w-2 h-2 rounded-full flex-shrink-0 mt-2',
            comment.status === 'NEW' && 'bg-blue-500',
            comment.status === 'IN_PROGRESS' && 'bg-yellow-500',
            comment.status === 'DONE' && 'bg-green-500',
            comment.status === 'ESCALATED' && 'bg-red-500'
          )}
        />
      </div>
    </button>
  );
}
