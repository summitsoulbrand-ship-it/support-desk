/**
 * Judge.me API Client
 * Fetches product reviews from Judge.me
 */

import { HttpClient } from '@/lib/http/client';
import { createIntegrationClient } from '@/lib/http/integration-client';

export interface JudgemeConfig {
  apiToken: string;
  shopDomain: string;
}

export interface JudgemeReview {
  id: number;
  title: string;
  body: string;
  rating: number;
  reviewer: {
    id: number;
    name: string;
    email: string;
    externalId?: string;
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
  /** Storefront visibility: 'ok' published, 'spam' hidden, 'not-yet' pending curation */
  curated?: string;
  /** Where the review came from, e.g. 'new-rre-flow', 'web', 'loox', 'shop-app'. Imported sources (loox) and shop-app are read-only. */
  source?: string;
  replied: boolean;
  reply?: {
    body: string;
    createdAt: string;
  };
  pictureUrls?: string[];
}

export interface JudgemeReviewsResponse {
  reviews: JudgemeReview[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
}

const API_BASE = 'https://judge.me/api/v1';

/**
 * Judge.me API Client
 */
export class JudgemeClient {
  private apiToken: string;
  private shopDomain: string;
  private http: HttpClient;

  constructor(config: JudgemeConfig) {
    this.apiToken = config.apiToken;
    this.shopDomain = config.shopDomain;
    // Per the Judge.me OpenAPI spec, the API key must be passed as the
    // X-Api-Token header. Writes (e.g. POST /replies) require the PRIVATE
    // key, recognized only via that header - passing the token as the
    // api_token query param gets treated as public/read-only access, which is
    // why replies failed with 401 "Review is readonly".
    this.http = new HttpClient({
      baseUrl: API_BASE,
      defaultHeaders: {
        'Accept': 'application/json',
        'X-Api-Token': this.apiToken,
      },
      timeoutMs: 10_000,
      buildError: (status, text) =>
        new Error(`Judge.me API error: ${status} ${text}`),
    });
  }

  /**
   * Make authenticated API request (GET)
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    // The legacy api_token query param still works for public reads, so it
    // stays here as a safety belt - but the X-Api-Token header (set on the
    // HttpClient) is what authenticates the private key.
    return this.http.request<T>(endpoint, {
      query: {
        api_token: this.apiToken,
        shop_domain: this.shopDomain,
        ...params,
      },
    });
  }

  /**
   * Make authenticated API request (POST/PUT)
   */
  private async postRequest<T>(
    endpoint: string,
    method: 'POST' | 'PUT' = 'POST',
    body: Record<string, unknown> = {}
  ): Promise<T> {
    // Auth rides in the X-Api-Token header; keep only shop_domain in the
    // query string.
    return this.http.request<T>(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      query: { shop_domain: this.shopDomain },
      body,
      parse: async (response) => {
        // Some Judge.me write endpoints (e.g. POST /replies) return 200 with an
        // empty body - a 2xx is success regardless of what the body contains
        const text = await response.text();
        if (!text.trim()) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return undefined as T;
        }
      },
    });
  }

  /**
   * Get reviews by customer email
   */
  async getReviewsByEmail(
    email: string,
    page = 1,
    perPage = 10,
    rating?: number
  ): Promise<JudgemeReviewsResponse> {
    const params: Record<string, string | number> = {
      reviewer_email: email,
      page,
      per_page: perPage,
    };
    if (rating !== undefined) {
      params.rating = rating;
    }

    const response = await this.request<{
      reviews: Array<{
        id: number;
        title: string;
        body: string;
        rating: number;
        reviewer: {
          id: number;
          name: string;
          email: string;
          external_id?: string;
        };
        product_title: string;
        product_handle: string;
        product_id: number;
        created_at: string;
        verified: string;
        featured: boolean;
        hidden: boolean;
        curated?: string;
        source?: string;
        has_reply: boolean;
        public_reply?: {
          body: string;
          created_at: string;
        };
        pictures: Array<{ urls: { original: string } }>;
      }>;
      current_page: number;
      total_pages: number;
      total_count: number;
    }>('/reviews', params);

    return {
      reviews: response.reviews.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        rating: r.rating,
        reviewer: {
          id: r.reviewer.id,
          name: r.reviewer.name,
          email: r.reviewer.email,
          externalId: r.reviewer.external_id,
        },
        product: {
          id: r.product_id,
          handle: r.product_handle,
          title: r.product_title,
        },
        createdAt: r.created_at,
        verifiedPurchase: r.verified === 'verified-purchase',
        featured: r.featured,
        hidden: r.hidden,
        curated: r.curated,
        source: r.source,
        replied: r.has_reply,
        reply: r.public_reply ? {
          body: r.public_reply.body,
          createdAt: r.public_reply.created_at,
        } : undefined,
        pictureUrls: r.pictures?.map((p) => p.urls.original) || [],
      })),
      currentPage: response.current_page,
      totalPages: response.total_pages,
      totalCount: response.total_count,
    };
  }

  /**
   * Get all reviews for the shop (recent first)
   */
  async getRecentReviews(page = 1, perPage = 10, rating?: number): Promise<JudgemeReviewsResponse> {
    const params: Record<string, string | number> = {
      page,
      per_page: perPage,
    };
    if (rating !== undefined) {
      params.rating = rating;
    }

    const response = await this.request<{
      reviews: Array<{
        id: number;
        title: string;
        body: string;
        rating: number;
        reviewer: {
          id: number;
          name: string;
          email: string;
          external_id?: string;
        };
        product_title: string;
        product_handle: string;
        product_id: number;
        created_at: string;
        verified: string;
        featured: boolean;
        hidden: boolean;
        curated?: string;
        source?: string;
        has_reply: boolean;
        public_reply?: {
          body: string;
          created_at: string;
        };
        pictures: Array<{ urls: { original: string } }>;
      }>;
      current_page: number;
      total_pages: number;
      total_count: number;
    }>('/reviews', params);

    return {
      reviews: response.reviews.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        rating: r.rating,
        reviewer: {
          id: r.reviewer.id,
          name: r.reviewer.name,
          email: r.reviewer.email,
          externalId: r.reviewer.external_id,
        },
        product: {
          id: r.product_id,
          handle: r.product_handle,
          title: r.product_title,
        },
        createdAt: r.created_at,
        verifiedPurchase: r.verified === 'verified-purchase',
        featured: r.featured,
        hidden: r.hidden,
        curated: r.curated,
        source: r.source,
        replied: r.has_reply,
        reply: r.public_reply ? {
          body: r.public_reply.body,
          createdAt: r.public_reply.created_at,
        } : undefined,
        pictureUrls: r.pictures?.map((p) => p.urls.original) || [],
      })),
      currentPage: response.current_page,
      totalPages: response.total_pages,
      totalCount: response.total_count,
    };
  }

  /**
   * Reply to a review (public store reply on the widget).
   * Judge.me API: POST /replies { review_id, reply: { content } }
   */
  async replyToReview(reviewId: number, body: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.postRequest(`/replies`, 'POST', {
        review_id: reviewId,
        send_reply_email: true,
        reply: { content: body },
      });
      return { success: true, message: 'Reply posted successfully' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to post reply',
      };
    }
  }

  /**
   * Update an existing reply. Judge.me has no update endpoint; posting a new
   * reply replaces the store's reply on the review (one store reply each).
   */
  async updateReply(reviewId: number, body: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.postRequest(`/replies`, 'POST', {
        review_id: reviewId,
        send_reply_email: false,
        reply: { content: body },
      });
      return { success: true, message: 'Reply updated successfully' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update reply',
      };
    }
  }

  /**
   * Publish or hide a review on the storefront.
   * Judge.me's curation flag controls visibility: 'ok' = published,
   * 'spam' = hidden (per their API: PUT /reviews/{id} { review: { curated } }).
   */
  async setReviewCuration(
    reviewId: number,
    curated: 'ok' | 'spam'
  ): Promise<{ success: boolean; message: string }> {
    try {
      await this.postRequest(`/reviews/${reviewId}`, 'PUT', {
        curated,
      });
      return {
        success: true,
        message: curated === 'spam' ? 'Review hidden from storefront' : 'Review published',
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update review visibility',
      };
    }
  }

  /**
   * Test connection to Judge.me API
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.getRecentReviews(1, 1);
      return { success: true, message: 'Connected to Judge.me' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to connect',
      };
    }
  }
}

/**
 * Create a Judge.me client from integration settings
 */
export async function createJudgemeClient(): Promise<JudgemeClient | null> {
  return createIntegrationClient(
    'JUDGEME',
    (config: JudgemeConfig) => new JudgemeClient(config)
  );
}
