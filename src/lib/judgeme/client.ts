/**
 * Judge.me API Client
 * Fetches product reviews from Judge.me
 */

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

  constructor(config: JudgemeConfig) {
    this.apiToken = config.apiToken;
    this.shopDomain = config.shopDomain;
  }

  /**
   * Make authenticated API request (GET)
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    const url = new URL(`${API_BASE}${endpoint}`);
    url.searchParams.set('api_token', this.apiToken);
    url.searchParams.set('shop_domain', this.shopDomain);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Judge.me API error: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * Make authenticated API request (POST/PUT)
   */
  private async postRequest<T>(
    endpoint: string,
    method: 'POST' | 'PUT' = 'POST',
    body: Record<string, unknown> = {}
  ): Promise<T> {
    const url = new URL(`${API_BASE}${endpoint}`);
    url.searchParams.set('api_token', this.apiToken);
    url.searchParams.set('shop_domain', this.shopDomain);

    const response = await fetch(url.toString(), {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Judge.me API error: ${response.status} ${errorText}`);
    }

    return response.json();
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
   * Reply to a review
   */
  async replyToReview(reviewId: number, body: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.postRequest(`/reviews/${reviewId}/reply`, 'POST', {
        body,
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
   * Update an existing reply
   */
  async updateReply(reviewId: number, body: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.postRequest(`/reviews/${reviewId}/reply`, 'PUT', {
        body,
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
  const { default: prisma } = await import('@/lib/db');
  const { decryptJson } = await import('@/lib/encryption');

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'JUDGEME' },
  });

  if (!settings || !settings.enabled) {
    return null;
  }

  const config = decryptJson<JudgemeConfig>(settings.encryptedData);
  return new JudgemeClient(config);
}
