'use client';

/**
 * Reviews page - Judge.me reviews with a "needs attention" queue:
 * low-star reviews arrive with a pre-written reply ready to publish, and
 * reviews can be hidden/published without logging into Judge.me.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Star, Search, ChevronLeft, ChevronRight, ExternalLink, CheckCircle, Image, MessageSquare, Send, Pencil, X, EyeOff, Eye, Sparkles, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Review {
  id: number;
  title: string;
  body: string;
  rating: number;
  reviewer: {
    id: number;
    name: string;
    email: string;
  };
  product: {
    id: number;
    handle: string;
    title: string;
  };
  createdAt: string;
  verifiedPurchase: boolean;
  featured: boolean;
  hidden: boolean;
  curated?: string;
  replied: boolean;
  reply?: {
    body: string;
    createdAt: string;
  };
  pictureUrls?: string[];
}

interface AttentionDraft {
  id: string;
  reviewId: number;
  rating: number;
  reviewerName?: string | null;
  reviewTitle?: string | null;
  reviewBody?: string | null;
  productTitle?: string | null;
  reviewCreatedAt?: string | null;
  body: string;
  status: 'PENDING' | 'READY' | 'FAILED' | 'HANDLED';
  error?: string | null;
}

interface ReviewsResponse {
  reviews: Review[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn(
            'w-4 h-4',
            star <= rating ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'
          )}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  review,
  draftBody,
  onReplySuccess,
}: {
  review: Review;
  draftBody?: string;
  onReplySuccess: () => void;
}) {
  const [showImages, setShowImages] = useState(false);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const isHidden = review.curated === 'spam' || review.hidden;

  const replyMutation = useMutation({
    mutationFn: async ({ message, isUpdate }: { message: string; isUpdate: boolean }) => {
      const res = await fetch(`/api/reviews/${review.id}/reply`, {
        method: isUpdate ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to post reply');
      }
      return res.json();
    },
    onSuccess: () => {
      setShowReplyForm(false);
      setIsEditing(false);
      onReplySuccess();
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: async (action: 'hide' | 'publish') => {
      const res = await fetch(`/api/reviews/${review.id}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update visibility');
      }
      return res.json();
    },
    onSuccess: () => onReplySuccess(),
  });

  const handleSubmitReply = () => {
    if (!replyText.trim()) return;
    replyMutation.mutate({ message: replyText.trim(), isUpdate: isEditing });
  };

  const handleStartEdit = () => {
    setReplyText(review.reply?.body || '');
    setIsEditing(true);
    setShowReplyForm(true);
  };

  const handleOpenReply = () => {
    // Pre-fill with the AI draft when one was prepared for this review
    setReplyText(draftBody || '');
    setShowReplyForm(true);
  };

  const handleCancel = () => {
    setShowReplyForm(false);
    setIsEditing(false);
    setReplyText('');
  };

  return (
    <div className={cn(
      'bg-white border rounded-lg p-4',
      isHidden && 'opacity-60'
    )}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <StarRating rating={review.rating} />
            {review.verifiedPurchase && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle className="w-3 h-3" />
                Verified
              </span>
            )}
            {review.featured && (
              <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">
                Featured
              </span>
            )}
            {isHidden && (
              <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                Hidden
              </span>
            )}
            {review.replied && (
              <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                Replied
              </span>
            )}
          </div>
          <h3 className="font-medium text-gray-900">{review.title || 'No title'}</h3>
        </div>
        <span className="text-xs text-gray-500">
          {new Date(review.createdAt).toLocaleDateString()}
        </span>
      </div>

      <p className="text-sm text-gray-700 mb-3 whitespace-pre-wrap">{review.body}</p>

      {review.pictureUrls && review.pictureUrls.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setShowImages(!showImages)}
            className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            <Image className="w-3 h-3" />
            {review.pictureUrls.length} photo{review.pictureUrls.length > 1 ? 's' : ''}
          </button>
          {showImages && (
            <div className="flex gap-2 mt-2 flex-wrap">
              {review.pictureUrls.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={url}
                    alt={`Review photo ${i + 1}`}
                    className="w-20 h-20 object-cover rounded border hover:opacity-80"
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500 pt-3 border-t">
        <div>
          <span className="font-medium text-gray-700">{review.reviewer.name}</span>
          <span className="mx-1">•</span>
          <span>{review.reviewer.email}</span>
        </div>
        <a
          href={`https://judge.me/reviews/${review.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-blue-600 hover:underline"
        >
          View <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="mt-2 text-xs">
        <span className="text-gray-500">Product:</span>{' '}
        <span className="text-gray-700 font-medium">{review.product.title}</span>
      </div>

      {/* Existing reply indicator */}
      {review.replied && !showReplyForm && (
        <div className="mt-3 bg-blue-50 rounded p-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-blue-600" />
              <span className="text-blue-700 font-medium">Store reply</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`https://judge.me/reviews/${review.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                View on Judge.me <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={handleStartEdit}
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            </div>
          </div>
          {review.reply?.body && (
            <p className="mt-2 text-gray-700 whitespace-pre-wrap">{review.reply.body}</p>
          )}
        </div>
      )}

      {/* Reply form */}
      {showReplyForm && (
        <div className="mt-3 border rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">
              {isEditing ? 'Update Reply' : 'Write a Reply'}
            </span>
            <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          {isEditing && !review.reply?.body && (
            <p className="text-xs text-gray-500 mb-2">
              Note: The current reply content could not be loaded from Judge.me. Enter your new reply text below.
            </p>
          )}
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write your reply..."
            className="w-full border rounded p-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={3}
          />
          {replyMutation.error && (
            <p className="text-xs text-red-600 mt-1">{replyMutation.error.message}</p>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmitReply}
              disabled={!replyText.trim() || replyMutation.isPending}
              loading={replyMutation.isPending}
            >
              <Send className="w-3 h-3 mr-1" />
              {isEditing ? 'Update' : 'Send'}
            </Button>
          </div>
        </div>
      )}

      {/* Actions row (when form not shown) */}
      {!showReplyForm && (
        <div className="mt-3 flex items-center gap-2">
          {!review.replied && (
            <Button
              variant={draftBody ? 'primary' : 'ghost'}
              size="sm"
              onClick={handleOpenReply}
              className={draftBody ? '' : 'text-gray-600'}
            >
              {draftBody ? (
                <Sparkles className="w-4 h-4 mr-1" />
              ) : (
                <MessageSquare className="w-4 h-4 mr-1" />
              )}
              {draftBody ? 'Reply (draft ready)' : 'Reply'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => visibilityMutation.mutate(isHidden ? 'publish' : 'hide')}
            loading={visibilityMutation.isPending}
            className="text-gray-600"
            title={
              isHidden
                ? 'Show this review on the storefront again'
                : 'Hide this review from the storefront'
            }
          >
            {isHidden ? (
              <>
                <Eye className="w-4 h-4 mr-1" />
                Publish
              </>
            ) : (
              <>
                <EyeOff className="w-4 h-4 mr-1" />
                Hide
              </>
            )}
          </Button>
          {visibilityMutation.error && (
            <span className="text-xs text-red-600">{visibilityMutation.error.message}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Needs-attention card: a low-star review with its pre-written reply,
 * editable and publishable in place. Hide resolves it too.
 */
function AttentionCard({ draft, onResolved }: { draft: AttentionDraft; onResolved: () => void }) {
  const [replyText, setReplyText] = useState(draft.body);

  const replyMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(`/api/reviews/${draft.reviewId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to post reply');
      }
      return res.json();
    },
    onSuccess: () => onResolved(),
  });

  const hideMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/reviews/${draft.reviewId}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'hide' }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to hide review');
      }
      return res.json();
    },
    onSuccess: () => onResolved(),
  });

  return (
    <div className="bg-white border border-amber-200 rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <StarRating rating={draft.rating} />
          <span className="text-sm font-medium text-gray-900">
            {draft.reviewerName || 'Customer'}
          </span>
          {draft.productTitle && (
            <span className="text-xs text-gray-500 truncate">{draft.productTitle}</span>
          )}
        </div>
        <span className="text-xs text-gray-500">
          {draft.reviewCreatedAt ? new Date(draft.reviewCreatedAt).toLocaleDateString() : ''}
        </span>
      </div>

      {draft.reviewTitle && (
        <p className="text-sm font-medium text-gray-900">{draft.reviewTitle}</p>
      )}
      <p className="text-sm text-gray-700 mb-3 whitespace-pre-wrap">
        {draft.reviewBody || '(no review text)'}
      </p>

      {draft.status === 'FAILED' ? (
        <p className="text-xs text-red-600 mb-2">
          Draft generation failed{draft.error ? `: ${draft.error}` : ''} - write a reply below.
        </p>
      ) : (
        <p className="text-xs text-emerald-700 mb-1 flex items-center gap-1">
          <Sparkles className="w-3 h-3" />
          Suggested public reply - review, tweak, publish:
        </p>
      )}
      <textarea
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
        className="w-full border rounded p-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        rows={3}
      />
      {(replyMutation.error || hideMutation.error) && (
        <p className="text-xs text-red-600 mt-1">
          {replyMutation.error?.message || hideMutation.error?.message}
        </p>
      )}
      <div className="flex items-center justify-between mt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (window.confirm('Hide this review from the storefront? It will not be shown to customers.')) {
              hideMutation.mutate();
            }
          }}
          loading={hideMutation.isPending}
          className="text-gray-600"
        >
          <EyeOff className="w-4 h-4 mr-1" />
          Hide review
        </Button>
        <Button
          size="sm"
          onClick={() => replyMutation.mutate(replyText.trim())}
          disabled={!replyText.trim() || replyMutation.isPending}
          loading={replyMutation.isPending}
        >
          <Send className="w-3 h-3 mr-1" />
          Publish reply
        </Button>
      </div>
    </div>
  );
}

export default function ReviewsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'attention' | 'all'>('attention');
  const [page, setPage] = useState(1);
  const [searchEmail, setSearchEmail] = useState('');
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  // Answered reviews are hidden by default - the queue is for open work
  const [showAnswered, setShowAnswered] = useState(false);

  // Low-star reviews waiting for a reply, with pre-written drafts
  const { data: attentionData, isLoading: attentionLoading } = useQuery<{
    drafts: AttentionDraft[];
  }>({
    queryKey: ['review-attention'],
    queryFn: async () => {
      const res = await fetch('/api/reviews/attention');
      if (!res.ok) throw new Error('Failed to fetch attention reviews');
      return res.json();
    },
    refetchInterval: 60000,
  });
  const attentionDrafts = (attentionData?.drafts || []).filter(
    (d) => d.status !== 'HANDLED'
  );

  // Drafts by review id so the All tab pre-fills replies too
  const draftsByReviewId = new Map(
    attentionDrafts.filter((d) => d.body).map((d) => [d.reviewId, d.body])
  );

  const resolveAttention = () => {
    queryClient.invalidateQueries({ queryKey: ['review-attention'] });
    queryClient.invalidateQueries({ queryKey: ['reviews'] });
  };

  const { data, isLoading, error, refetch } = useQuery<ReviewsResponse>({
    queryKey: ['reviews', page, activeEmail, ratingFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        perPage: '20',
      });
      if (activeEmail) {
        params.set('email', activeEmail);
      }
      if (ratingFilter !== null) {
        params.set('rating', String(ratingFilter));
      }
      const res = await fetch(`/api/reviews?${params}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch reviews');
      }
      return res.json();
    },
    enabled: tab === 'all',
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveEmail(searchEmail.trim() || null);
    setPage(1);
  };

  const clearSearch = () => {
    setSearchEmail('');
    setActiveEmail(null);
    setPage(1);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Product Reviews</h1>
          <p className="text-sm text-gray-500 mt-1">
            Reviews from Judge.me - reply and hide without leaving the tool
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b mb-6">
        <button
          onClick={() => setTab('attention')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            tab === 'attention'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          )}
        >
          <AlertTriangle className="w-4 h-4" />
          Needs attention
          {attentionDrafts.length > 0 && (
            <span className="bg-amber-100 text-amber-800 text-xs px-1.5 py-0.5 rounded-full">
              {attentionDrafts.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('all')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            tab === 'all'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          )}
        >
          <Star className="w-4 h-4" />
          All reviews
        </button>
      </div>

      {/* Needs attention tab */}
      {tab === 'attention' && (
        <>
          <p className="text-sm text-gray-600 mb-4">
            Reviews rated 3 stars or less without a store reply. Each one comes
            with a suggested public reply - edit if needed, then publish (or
            hide the review).
          </p>
          {attentionLoading ? (
            <div className="space-y-4">
              {[1, 2].map((i) => (
                <div key={i} className="bg-white border rounded-lg p-4 animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-1/4 mb-3" />
                  <div className="h-3 bg-gray-200 rounded w-full" />
                </div>
              ))}
            </div>
          ) : attentionDrafts.length === 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-8 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-900 mb-1">All caught up</h3>
              <p className="text-sm text-gray-600">
                No low-star reviews waiting for a reply. New ones appear here
                automatically with a draft ready.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {attentionDrafts.map((draft) => (
                <AttentionCard key={draft.id} draft={draft} onResolved={resolveAttention} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'all' && (
      <>
      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        {/* Search by email */}
        <form onSubmit={handleSearch} className="flex gap-2 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              placeholder="Search by customer email..."
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {activeEmail && (
            <Button type="button" variant="ghost" onClick={clearSearch}>
              Clear
            </Button>
          )}
        </form>

        {/* Rating filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Rating:</span>
          <div className="flex gap-1">
            <button
              onClick={() => { setRatingFilter(null); setPage(1); }}
              className={cn(
                'px-2 py-1 text-xs rounded border',
                ratingFilter === null
                  ? 'bg-blue-100 border-blue-300 text-blue-700'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              All
            </button>
            {[5, 4, 3, 2, 1].map((rating) => (
              <button
                key={rating}
                onClick={() => { setRatingFilter(rating); setPage(1); }}
                className={cn(
                  'px-2 py-1 text-xs rounded border flex items-center gap-1',
                  ratingFilter === rating
                    ? 'bg-blue-100 border-blue-300 text-blue-700'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                )}
              >
                {rating}
                <Star className={cn(
                  'w-3 h-3',
                  ratingFilter === rating ? 'fill-blue-500 text-blue-500' : 'fill-yellow-400 text-yellow-400'
                )} />
              </button>
            ))}
          </div>
        </div>

        {/* Answered toggle */}
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showAnswered}
            onChange={(e) => setShowAnswered(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show answered reviews
        </label>
      </div>

      {(activeEmail || ratingFilter !== null) && (
        <div className="mb-4 text-sm text-gray-600 flex items-center gap-2">
          <span>Filters:</span>
          {activeEmail && (
            <span className="bg-gray-100 px-2 py-0.5 rounded">
              Email: <span className="font-medium">{activeEmail}</span>
            </span>
          )}
          {ratingFilter !== null && (
            <span className="bg-gray-100 px-2 py-0.5 rounded flex items-center gap-1">
              Rating: <span className="font-medium">{ratingFilter}</span>
              <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
            </span>
          )}
          <button
            onClick={() => { clearSearch(); setRatingFilter(null); }}
            className="text-blue-600 hover:underline text-xs"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-700">{error.message}</p>
          <p className="text-sm text-red-600 mt-1">
            Make sure Judge.me integration is configured in Settings → Integrations
          </p>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white border rounded-lg p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/4 mb-3" />
              <div className="h-3 bg-gray-200 rounded w-full mb-2" />
              <div className="h-3 bg-gray-200 rounded w-3/4" />
            </div>
          ))}
        </div>
      )}

      {/* Reviews list */}
      {data && !isLoading && (
        <>
          {(() => {
            const visibleReviews = data.reviews.filter(
              (r) => showAnswered || !r.replied
            );
            const hiddenCount = data.reviews.length - visibleReviews.length;
            return visibleReviews.length === 0 ? (
            <div className="bg-gray-50 border rounded-lg p-8 text-center">
              <Star className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-900 mb-1">
                {hiddenCount > 0 ? 'All answered' : 'No reviews found'}
              </h3>
              <p className="text-sm text-gray-500">
                {hiddenCount > 0
                  ? `${hiddenCount} answered review${hiddenCount > 1 ? 's' : ''} on this page - tick "Show answered reviews" to see them`
                  : activeEmail
                    ? `No reviews found for ${activeEmail}`
                    : 'No reviews have been submitted yet'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {hiddenCount > 0 && (
                <p className="text-xs text-gray-500">
                  {hiddenCount} answered review{hiddenCount > 1 ? 's' : ''} hidden on this page
                </p>
              )}
              {visibleReviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  review={review}
                  draftBody={draftsByReviewId.get(review.id)}
                  onReplySuccess={() => {
                    refetch();
                    resolveAttention();
                  }}
                />
              ))}
            </div>
          );
          })()}

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Previous
              </Button>
              <span className="text-sm text-gray-600">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}
