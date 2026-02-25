'use client';

/**
 * Social Comment Detail View
 * Shows full comment thread and actions
 */

import { useState } from 'react';
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

export function SocialCommentDetail({ commentId, onClose }: SocialCommentDetailProps) {
  const queryClient = useQueryClient();
  const [replyMessage, setReplyMessage] = useState('');
  const [showRuleHistory, setShowRuleHistory] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showRefineInput, setShowRefineInput] = useState(false);
  const [refineInstructions, setRefineInstructions] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['social-comment', commentId],
    queryFn: async () => {
      const res = await fetch(`/api/social/comments/${commentId}`);
      if (!res.ok) throw new Error('Failed to fetch comment');
      return res.json();
    },
  });

  const actionMutation = useMutation({
    mutationFn: async (action: { action: string; message?: string }) => {
      const res = await fetch(`/api/social/comments/${commentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-comment', commentId] });
      queryClient.invalidateQueries({ queryKey: ['social-comments'] });
      setReplyMessage('');
    },
  });

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
  const PlatformIcon = comment.platform === 'FACEBOOK' ? Facebook : Instagram;
  const isAd = comment.object.adId != null;

  const handleReply = () => {
    if (!replyMessage.trim()) return;
    actionMutation.mutate({ action: 'reply', message: replyMessage.trim() });
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

            {/* Main comment */}
            <div className="mb-6">
              <div className="flex items-start gap-3">
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
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium">{comment.authorName}</span>
                    {comment.hidden && (
                      <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded flex items-center gap-1">
                        <EyeOff className="w-3 h-3" />
                        Hidden
                      </span>
                    )}
                  </div>
                  <p className="text-gray-700 whitespace-pre-wrap">{comment.message}</p>
                  {comment.attachmentUrl && (
                    <img
                      src={comment.attachmentUrl}
                      alt="Attachment"
                      className="mt-2 rounded-lg max-w-xs"
                    />
                  )}
                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <ThumbsUp className="w-4 h-4" />
                      {comment.likeCount}
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageCircle className="w-4 h-4" />
                      {comment.replyCount} replies
                    </span>
                    {comment.permalink && (
                      <a
                        href={comment.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 hover:text-blue-600"
                      >
                        <ExternalLink className="w-4 h-4" />
                        View
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Replies */}
            {comment.replies && comment.replies.length > 0 && (
              <div className="border-l-2 border-gray-200 pl-6 ml-5 space-y-4">
                {comment.replies.map((reply: any) => (
                  <div key={reply.id} className="flex items-start gap-3">
                    {reply.authorProfileUrl ? (
                      <img
                        src={reply.authorProfileUrl}
                        alt={reply.authorName}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                        <span className="text-xs font-medium text-gray-600">
                          {reply.authorName.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{reply.authorName}</span>
                        {reply.isPageOwner && (
                          <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
                            Page
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          {formatDistanceToNow(new Date(reply.commentedAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700">{reply.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

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

                {/* Reply input row */}
                <div className="flex gap-2">
                  <Input
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    placeholder="Write a reply..."
                    className="flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleReply();
                      }
                    }}
                  />
                  <Button
                    onClick={handleReply}
                    disabled={!replyMessage.trim() || actionMutation.isPending}
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
