'use client';

/**
 * Social Comment Detail View
 * Shows full comment thread and actions
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Facebook,
  Instagram,
  X,
  Send,
  ThumbsUp,
  Eye,
  EyeOff,
  Trash2,
  ExternalLink,
  Copy,
  MessageCircle,
  Megaphone,
  Image,
  Video,
  CheckCircle,
  Clock,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Zap,
  Sparkles,
  Pencil,
} from 'lucide-react';

interface SocialCommentDetailProps {
  commentId: string;
  onClose: () => void;
}

/** Facebook-style compact relative time: 9h, 3d, 1w */
function shortTime(date: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 52) return `${w}w`;
  return `${Math.floor(w / 52)}y`;
}

interface ThreadComment {
  id: string;
  authorName: string;
  authorProfileUrl?: string | null;
  message: string;
  attachmentUrl?: string | null;
  isPageOwner: boolean;
  commentedAt: string;
  hidden: boolean;
  likeCount: number;
  isLikedByPage: boolean;
  canReply: boolean;
  canLike: boolean;
  canHide: boolean;
  replies?: ThreadComment[];
}

export function SocialCommentDetail({ commentId, onClose }: SocialCommentDetailProps) {
  const queryClient = useQueryClient();
  const [replyMessage, setReplyMessage] = useState('');
  const [showRuleHistory, setShowRuleHistory] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showRefineInput, setShowRefineInput] = useState(false);
  const [refineInstructions, setRefineInstructions] = useState('');
  const [showGifInput, setShowGifInput] = useState(false);
  const [gifUrl, setGifUrl] = useState('');
  // Which comment the composer replies to (defaults to the selected one)
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  // Optimistic like states so the button reacts instantly
  const [likedOverrides, setLikedOverrides] = useState<Record<string, boolean>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ['social-comment', commentId],
    queryFn: async () => {
      const res = await fetch(`/api/social/comments/${commentId}`);
      if (!res.ok) throw new Error('Failed to fetch comment');
      return res.json();
    },
  });

  const actionMutation = useMutation({
    mutationFn: async (action: {
      action: string;
      message?: string;
      gifUrl?: string;
      targetId?: string;
    }) => {
      const { targetId, ...payload } = action;
      const res = await fetch(`/api/social/comments/${targetId || commentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      return res.json();
    },
    // Optimistic: likes flip instantly, replies appear in the thread
    // immediately (the Meta round-trip confirms in the background)
    onMutate: async (action) => {
      const target = action.targetId || commentId;
      if (action.action === 'like') {
        setLikedOverrides((prev) => ({ ...prev, [target]: true }));
      } else if (action.action === 'unlike') {
        setLikedOverrides((prev) => ({ ...prev, [target]: false }));
      } else if (action.action === 'reply') {
        setReplyMessage('');
        setGifUrl('');
        setShowGifInput(false);

        await queryClient.cancelQueries({ queryKey: ['social-comment', commentId] });
        const previous = queryClient.getQueryData(['social-comment', commentId]);
        const tempReply = {
          id: `optimistic-${target}`,
          authorName: 'Me',
          authorProfileUrl: null,
          message: action.message || (action.gifUrl ? '(GIF)' : ''),
          attachmentUrl: action.gifUrl || null,
          isPageOwner: true,
          commentedAt: new Date().toISOString(),
          hidden: false,
          likeCount: 0,
          isLikedByPage: false,
          canReply: false,
          canLike: false,
          canHide: false,
          pending: true,
        };
        queryClient.setQueryData(
          ['social-comment', commentId],
          (old: { comment?: unknown; thread?: Array<{ id: string; replies?: unknown[] }> } | undefined) => {
            if (!old?.thread) return old;
            return {
              ...old,
              thread: old.thread.map((c) =>
                c.id === target
                  ? { ...c, replies: [...(c.replies || []), tempReply] }
                  : c
              ),
            };
          }
        );
        return { previous };
      }
      return undefined;
    },
    onError: (_err, action, context) => {
      const target = action.targetId || commentId;
      if (action.action === 'like' || action.action === 'unlike') {
        setLikedOverrides((prev) => {
          const next = { ...prev };
          delete next[target];
          return next;
        });
      }
      if (action.action === 'reply' && context?.previous) {
        queryClient.setQueryData(['social-comment', commentId], context.previous);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-comment', commentId] });
      queryClient.invalidateQueries({ queryKey: ['social-comments'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });

  // Pre-fill the reply box with the worker's AI draft when one is waiting
  const aiDraft: string | undefined = data?.comment?.aiDraft;
  useEffect(() => {
    if (aiDraft && !replyMessage.trim()) {
      setReplyMessage(aiDraft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDraft, commentId]);

  // Reset composer state when switching comments
  useEffect(() => {
    setReplyTargetId(null);
    setLikedOverrides({});
    setReplyMessage('');
    setGifUrl('');
    setShowGifInput(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentId]);

  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch(`/api/social/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error || 'Update failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-comment', commentId] });
      queryClient.invalidateQueries({ queryKey: ['social-comments'] });
    },
  });

  const suggestMutation = useMutation({
    mutationKey: ['suggest-social', commentId],
    mutationFn: async (params?: { currentDraft?: string; instructions?: string }) => {
      const res = await fetch(`/api/social/comments/${commentId}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate suggestion');
      }
      return data;
    },
    onSuccess: (data) => {
      setReplyMessage(data.draft);
      setShowRefineInput(false);
      setRefineInstructions('');
    },
  });

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !data?.comment) {
    return (
      <div className="h-full flex items-center justify-center text-red-500">
        Failed to load comment
      </div>
    );
  }

  const comment = data.comment;
  const thread: ThreadComment[] = data.thread || [];
  const PlatformIcon = comment.platform === 'FACEBOOK' ? Facebook : Instagram;
  const isAd = comment.object.adId != null;

  const isLiked = (c: ThreadComment) => likedOverrides[c.id] ?? c.isLikedByPage;
  const toggleLike = (c: ThreadComment) =>
    actionMutation.mutate({
      action: isLiked(c) ? 'unlike' : 'like',
      targetId: c.id,
    });

  // The comment the composer will reply to (defaults to the selected one)
  const flatThread: ThreadComment[] = thread.flatMap((t) => [t, ...(t.replies || [])]);
  const replyTarget =
    (replyTargetId && flatThread.find((c) => c.id === replyTargetId)) ||
    flatThread.find((c) => c.id === commentId) ||
    null;

  const handleReply = () => {
    const trimmedGif = gifUrl.trim();
    if (!replyMessage.trim() && !trimmedGif) return;
    actionMutation.mutate({
      action: 'reply',
      message: replyMessage.trim() || undefined,
      gifUrl: trimmedGif || undefined,
      targetId: replyTarget?.id || commentId,
    });
  };

  const handleAction = (action: string) => {
    actionMutation.mutate({ action });
  };

  const handleStatusChange = (status: string) => {
    updateMutation.mutate({ status });
  };

  const copyPermalink = () => {
    if (comment.permalink) {
      navigator.clipboard.writeText(comment.permalink);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center',
              comment.platform === 'FACEBOOK' ? 'bg-blue-600' : 'bg-gradient-to-br from-purple-500 to-pink-500'
            )}
          >
            <PlatformIcon className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-900">{comment.authorName}</span>
              {comment.authorUsername && (
                <span className="text-sm text-gray-500">@{comment.authorUsername}</span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              {format(new Date(comment.commentedAt), 'PPp')}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <X className="w-5 h-5 text-gray-500" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex">
          {/* Comment thread */}
          <div className="flex-1 p-6 border-r">
            {/* Original Post/Ad */}
            {comment.object && (comment.object.message || comment.object.thumbnailUrl || comment.object.permalink) && (
              <div className="mb-6 bg-gray-50 rounded-lg border p-4">
                <div className="flex items-center gap-2 mb-3 text-xs text-gray-500">
                  {isAd ? (
                    <>
                      <Megaphone className="w-3.5 h-3.5" />
                      <span className="font-medium">Original Ad</span>
                      {comment.object.adName && (
                        <span className="text-purple-600">• {comment.object.adName}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <Image className="w-3.5 h-3.5" />
                      <span className="font-medium">Original Post</span>
                    </>
                  )}
                  {comment.object.permalink && (
                    <a
                      href={comment.object.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-blue-600 hover:underline flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      View on {comment.platform === 'FACEBOOK' ? 'Facebook' : 'Instagram'}
                    </a>
                  )}
                </div>
                {comment.object.thumbnailUrl && (
                  <div className="mb-3">
                    {comment.object.mediaType === 'VIDEO' ? (
                      <div className="relative">
                        <img
                          src={comment.object.thumbnailUrl}
                          alt="Video thumbnail"
                          className="w-full max-h-64 object-contain rounded-lg bg-black"
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-12 h-12 bg-black/60 rounded-full flex items-center justify-center">
                            <Video className="w-6 h-6 text-white" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <img
                        src={comment.object.thumbnailUrl}
                        alt="Post image"
                        className="w-full max-h-64 object-contain rounded-lg"
                      />
                    )}
                  </div>
                )}
                {comment.object.message && (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.object.message}</p>
                )}
              </div>
            )}

            {/* Conversation thread (Facebook-style) */}
            <div className="space-y-4 mb-2">
              {(thread.length > 0 ? thread : [comment as unknown as ThreadComment]).map(
                (top) => (
                  <CommentBubble
                    key={top.id}
                    comment={top}
                    depth={0}
                    selectedId={commentId}
                    isLiked={isLiked}
                    onLike={toggleLike}
                    onReplyTo={(c) => setReplyTargetId(c.id)}
                    onHide={(c) =>
                      actionMutation.mutate({
                        action: c.hidden ? 'unhide' : 'hide',
                        targetId: c.id,
                      })
                    }
                    pending={actionMutation.isPending}
                  />
                )
              )}
            </div>

            {/* Reply input */}
            {comment.canReply && (
              <div className="mt-6">
                {/* AI Suggestion buttons */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => suggestMutation.mutate(undefined)}
                    disabled={suggestMutation.isPending}
                  >
                    {suggestMutation.isPending && !refineInstructions ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4 mr-1" />
                    )}
                    Suggest Reply
                  </Button>
                  {replyMessage.trim() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowRefineInput(!showRefineInput)}
                      disabled={suggestMutation.isPending}
                    >
                      <Pencil className="w-4 h-4 mr-1" />
                      {showRefineInput ? 'Hide' : 'Edit with AI'}
                    </Button>
                  )}
                  {suggestMutation.error && (
                    <span className="text-sm text-red-500">
                      {suggestMutation.error.message}
                    </span>
                  )}
                </div>

                {/* Refine input */}
                {showRefineInput && (
                  <div className="mb-2 flex gap-2">
                    <input
                      type="text"
                      value={refineInstructions}
                      onChange={(e) => setRefineInstructions(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && refineInstructions.trim()) {
                          suggestMutation.mutate({
                            currentDraft: replyMessage,
                            instructions: refineInstructions.trim(),
                          });
                        }
                      }}
                      placeholder="e.g., make it friendlier, add emoji, be more formal..."
                      className="flex-1 px-3 py-1.5 text-sm border rounded-lg bg-white text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        suggestMutation.mutate({
                          currentDraft: replyMessage,
                          instructions: refineInstructions.trim(),
                        });
                      }}
                      disabled={!refineInstructions.trim() || suggestMutation.isPending}
                    >
                      {suggestMutation.isPending && refineInstructions ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Refine'
                      )}
                    </Button>
                  </div>
                )}

                {/* GIF attachment (Facebook only) */}
                {comment.platform === 'FACEBOOK' && showGifInput && (
                  <div className="mb-2">
                    <Input
                      value={gifUrl}
                      onChange={(e) => setGifUrl(e.target.value)}
                      placeholder="Paste a GIF link (e.g. https://media.giphy.com/...gif)"
                      className="flex-1"
                    />
                    {gifUrl.trim() && (
                      <img
                        src={gifUrl.trim()}
                        alt="GIF preview"
                        className="mt-2 max-h-32 rounded border"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                  </div>
                )}

                {/* Reply target chip */}
                {replyTarget && replyTarget.id !== commentId && (
                  <div className="mb-2 inline-flex items-center gap-2 text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded-full px-3 py-1">
                    Replying to {replyTarget.authorName}
                    <button
                      onClick={() => setReplyTargetId(null)}
                      className="text-blue-500 hover:text-blue-700"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* Reply input row */}
                <div className="flex gap-2">
                  <Input
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    placeholder={`Comment as Summit Soul${replyTarget && replyTarget.id !== commentId ? ` - replying to ${replyTarget.authorName}` : ''}...`}
                    className="flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleReply();
                      }
                    }}
                  />
                  {comment.platform === 'FACEBOOK' && (
                    <Button
                      variant={showGifInput ? 'primary' : 'secondary'}
                      onClick={() => setShowGifInput(!showGifInput)}
                      title="Attach a GIF to the reply"
                    >
                      GIF
                    </Button>
                  )}
                  <Button
                    onClick={handleReply}
                    disabled={(!replyMessage.trim() && !gifUrl.trim()) || actionMutation.isPending}
                  >
                    {actionMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 mt-6 pt-6 border-t">
              {comment.canLike && comment.platform === 'FACEBOOK' && (
                <Button
                  variant={comment.isLikedByPage ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => handleAction(comment.isLikedByPage ? 'unlike' : 'like')}
                  disabled={actionMutation.isPending}
                >
                  <ThumbsUp className="w-4 h-4 mr-1" />
                  {comment.isLikedByPage ? 'Liked' : 'Like'}
                </Button>
              )}
              {comment.canHide && comment.platform === 'FACEBOOK' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleAction(comment.hidden ? 'unhide' : 'hide')}
                  disabled={actionMutation.isPending}
                >
                  {comment.hidden ? (
                    <>
                      <Eye className="w-4 h-4 mr-1" />
                      Unhide
                    </>
                  ) : (
                    <>
                      <EyeOff className="w-4 h-4 mr-1" />
                      Hide
                    </>
                  )}
                </Button>
              )}
              {comment.canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => {
                    if (confirm('Are you sure you want to delete this comment?')) {
                      handleAction('delete');
                    }
                  }}
                  disabled={actionMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Delete
                </Button>
              )}
              {comment.permalink && (
                <Button variant="ghost" size="sm" onClick={copyPermalink}>
                  <Copy className="w-4 h-4 mr-1" />
                  Copy Link
                </Button>
              )}
            </div>

            {actionMutation.isError && (
              <div className="mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
                {actionMutation.error.message}
              </div>
            )}
          </div>

          {/* Sidebar - Post/Ad context */}
          <div className="w-80 p-6 bg-gray-50">
            {/* Status selector */}
            <div className="mb-6">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Status
              </label>
              <div className="flex flex-wrap gap-2 mt-2">
                {(['NEW', 'IN_PROGRESS', 'DONE', 'ESCALATED'] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => handleStatusChange(status)}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                      comment.status === status
                        ? status === 'NEW'
                          ? 'bg-blue-500 text-white'
                          : status === 'IN_PROGRESS'
                          ? 'bg-yellow-500 text-white'
                          : status === 'DONE'
                          ? 'bg-green-500 text-white'
                          : 'bg-red-500 text-white'
                        : 'bg-white border text-gray-700 hover:bg-gray-100'
                    )}
                  >
                    {status.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Post/Ad context */}
            <div className="mb-6">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide flex items-center gap-1">
                {isAd ? <Megaphone className="w-3 h-3" /> : <MessageCircle className="w-3 h-3" />}
                {isAd ? 'Ad Context' : 'Post Context'}
              </label>
              <div className="mt-2 bg-white rounded-lg border p-3">
                {comment.object.thumbnailUrl && (
                  <img
                    src={comment.object.thumbnailUrl}
                    alt="Post thumbnail"
                    className="w-full h-32 object-cover rounded-lg mb-3"
                  />
                )}
                {comment.object.message && (
                  <p className="text-sm text-gray-700 line-clamp-3 mb-2">
                    {comment.object.message}
                  </p>
                )}
                {isAd && (
                  <div className="text-xs space-y-1">
                    <p className="font-medium text-purple-700">{comment.object.adName}</p>
                    {comment.object.campaignName && (
                      <p className="text-gray-500">Campaign: {comment.object.campaignName}</p>
                    )}
                    {comment.object.adsetName && (
                      <p className="text-gray-500">Ad Set: {comment.object.adsetName}</p>
                    )}
                    {comment.object.destinationUrl && (
                      <a
                        href={comment.object.destinationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Landing Page
                      </a>
                    )}
                  </div>
                )}
                {comment.object.permalink && (
                  <a
                    href={comment.object.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    View {isAd ? 'Ad' : 'Post'}
                  </a>
                )}
              </div>
            </div>

            {/* Account info */}
            <div className="mb-6">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Account
              </label>
              <div className="mt-2 flex items-center gap-2">
                {comment.account.profilePictureUrl && (
                  <img
                    src={comment.account.profilePictureUrl}
                    alt={comment.account.name}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <div>
                  <p className="text-sm font-medium">{comment.account.name}</p>
                  <p className="text-xs text-gray-500">
                    {comment.account.platform === 'FACEBOOK' ? 'Facebook Page' : 'Instagram Business'}
                  </p>
                </div>
              </div>
            </div>

            {/* Automation history */}
            {comment.ruleRuns && comment.ruleRuns.length > 0 && (
              <div className="mb-6">
                <button
                  onClick={() => setShowRuleHistory(!showRuleHistory)}
                  className="flex items-center justify-between w-full text-xs font-medium text-gray-500 uppercase tracking-wide"
                >
                  <span className="flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    Automation History
                  </span>
                  {showRuleHistory ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </button>
                {showRuleHistory && (
                  <div className="mt-2 space-y-2">
                    {comment.ruleRuns.map((run: any) => (
                      <div
                        key={run.id}
                        className="bg-white rounded-lg border p-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{run.rule.name}</span>
                          {run.wasDryRun && (
                            <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                              Dry Run
                            </span>
                          )}
                        </div>
                        <p className="text-gray-500 mt-1">
                          {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Activity log */}
            {comment.actionLogs && comment.actionLogs.length > 0 && (
              <div>
                <button
                  onClick={() => setShowActivityLog(!showActivityLog)}
                  className="flex items-center justify-between w-full text-xs font-medium text-gray-500 uppercase tracking-wide"
                >
                  <span>Activity Log</span>
                  {showActivityLog ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </button>
                {showActivityLog && (
                  <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
                    {comment.actionLogs.map((log: any) => (
                      <div
                        key={log.id}
                        className="bg-white rounded-lg border p-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          {log.apiSuccess ? (
                            <CheckCircle className="w-3 h-3 text-green-500" />
                          ) : (
                            <AlertCircle className="w-3 h-3 text-red-500" />
                          )}
                          <span className="font-medium">{log.actionType}</span>
                        </div>
                        <p className="text-gray-500 mt-1">
                          by {log.actorName || log.actorType}
                        </p>
                        <p className="text-gray-400">
                          {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                        </p>
                        {log.apiError && (
                          <p className="text-red-500 mt-1">{log.apiError}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Facebook-style comment bubble with nested replies and inline actions.
 * Page-authored comments render with a blue tint and an Author badge,
 * exactly like Facebook shows the brand's own replies in-thread.
 */
function CommentBubble({
  comment,
  depth,
  selectedId,
  isLiked,
  onLike,
  onReplyTo,
  onHide,
  pending,
}: {
  comment: ThreadComment;
  depth: number;
  selectedId: string;
  isLiked: (c: ThreadComment) => boolean;
  onLike: (c: ThreadComment) => void;
  onReplyTo: (c: ThreadComment) => void;
  onHide: (c: ThreadComment) => void;
  pending: boolean;
}) {
  const liked = isLiked(comment);
  const isSelected = comment.id === selectedId;

  return (
    <div className={cn(depth > 0 && 'ml-10 mt-2')}>
      <div className="flex items-start gap-2">
        {comment.authorProfileUrl ? (
          <img
            src={comment.authorProfileUrl}
            alt={comment.authorName}
            className={cn('rounded-full flex-shrink-0', depth > 0 ? 'w-7 h-7' : 'w-8 h-8')}
          />
        ) : (
          <div
            className={cn(
              'rounded-full flex items-center justify-center flex-shrink-0',
              comment.isPageOwner ? 'bg-blue-100' : 'bg-gray-200',
              depth > 0 ? 'w-7 h-7' : 'w-8 h-8'
            )}
          >
            <span
              className={cn(
                'text-xs font-medium',
                comment.isPageOwner ? 'text-blue-700' : 'text-gray-600'
              )}
            >
              {comment.authorName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="min-w-0 max-w-[85%]">
          <div
            className={cn(
              'rounded-2xl px-3 py-2 inline-block',
              comment.isPageOwner ? 'bg-blue-50' : 'bg-gray-100',
              isSelected && 'ring-2 ring-blue-300',
              comment.hidden && 'opacity-50'
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold text-gray-900">
                {comment.authorName}
              </span>
              {comment.isPageOwner && (
                <span className="text-[10px] px-1.5 py-px bg-blue-600 text-white rounded-full">
                  Author
                </span>
              )}
              {comment.hidden && (
                <span className="text-[10px] px-1.5 py-px bg-gray-200 text-gray-600 rounded-full inline-flex items-center gap-0.5">
                  <EyeOff className="w-2.5 h-2.5" />
                  Hidden
                </span>
              )}
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
              {comment.message || (comment.attachmentUrl ? '' : '(no text)')}
            </p>
            {comment.attachmentUrl && (
              <img
                src={comment.attachmentUrl}
                alt="Attachment"
                className="mt-1 rounded-lg max-h-40"
              />
            )}
          </div>

          {/* Inline actions, Facebook-style */}
          <div className="flex items-center gap-3 mt-0.5 ml-2 text-xs text-gray-500">
            <span title={new Date(comment.commentedAt).toLocaleString()}>
              {shortTime(comment.commentedAt)}
            </span>
            {!comment.isPageOwner && comment.canLike && (
              <button
                onClick={() => onLike(comment)}
                disabled={pending}
                className={cn(
                  'font-semibold hover:underline',
                  liked ? 'text-blue-600' : 'text-gray-600'
                )}
              >
                {liked ? 'Liked' : 'Like'}
              </button>
            )}
            {!comment.isPageOwner && comment.canReply && (
              <button
                onClick={() => onReplyTo(comment)}
                disabled={pending}
                className="font-semibold text-gray-600 hover:underline"
              >
                Reply
              </button>
            )}
            {!comment.isPageOwner && comment.canHide && (
              <button
                onClick={() => onHide(comment)}
                disabled={pending}
                className="font-semibold text-gray-600 hover:underline"
              >
                {comment.hidden ? 'Unhide' : 'Hide'}
              </button>
            )}
            {comment.likeCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-gray-400">
                <ThumbsUp className="w-3 h-3 fill-blue-500 text-blue-500" />
                {comment.likeCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Nested replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="border-l-2 border-gray-100 ml-4 pl-0 mt-1">
          {comment.replies.map((reply) => (
            <CommentBubble
              key={reply.id}
              comment={reply}
              depth={depth + 1}
              selectedId={selectedId}
              isLiked={isLiked}
              onLike={onLike}
              onReplyTo={onReplyTo}
              onHide={onHide}
              pending={pending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
