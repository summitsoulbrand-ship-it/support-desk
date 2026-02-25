/**
 * TrackingMore API Client
 * On-demand shipment tracking data
 * API Docs: https://docs.trackingmore.com/
 */

export interface TrackingMoreConfig {
  apiKey: string;
}

export interface TrackingEvent {
  date: string; // ISO timestamp
  description: string;
  location?: string;
  status: string;
}

export interface TrackingResult {
  trackingNumber: string;
  carrier: string;
  carrierCode: string;
  status: TrackingStatus;
  statusDescription: string;
  estimatedDelivery?: string;
  deliveredAt?: string;
  shippedAt?: string; // Carrier pickup date
  labelCreatedAt?: string; // When shipping label was created
  lastUpdate?: string;
  origin?: string;
  destination?: string;
  events: TrackingEvent[];
}

export type TrackingStatus =
  | 'pending' // Tracking info not yet available
  | 'info_received' // Carrier has received info, not yet picked up
  | 'in_transit' // Package is in transit
  | 'out_for_delivery' // Out for delivery
  | 'delivered' // Delivered
  | 'failed_attempt' // Delivery attempt failed
  | 'exception' // Exception/problem
  | 'expired' // Tracking expired
  | 'unknown';

// Map TrackingMore status codes to our status
const STATUS_MAP: Record<string, TrackingStatus> = {
  pending: 'pending',
  notfound: 'pending',
  transit: 'in_transit',
  pickup: 'in_transit',
  delivered: 'delivered',
  undelivered: 'failed_attempt',
  exception: 'exception',
  expired: 'expired',
};

const API_BASE = 'https://api.trackingmore.com/v4';

/**
 * Normalize UTC midnight dates to local date strings
 * TrackingMore returns dates at midnight UTC (e.g., "2026-02-17T00:00:00+00:00")
 * which would shift to the previous day when converted to Pacific time.
 * This extracts just the date part for proper display.
 */
function normalizeDate(isoDate: string | undefined): string | undefined {
  if (!isoDate) return undefined;
  // If the date is at midnight UTC (T00:00:00), extract just the date part
  // and create a local date to avoid timezone shift
  if (isoDate.includes('T00:00:00')) {
    const datePart = isoDate.split('T')[0]; // "2026-02-17"
    // Return as ISO string with local midnight
    return `${datePart}T12:00:00`; // Use noon to avoid any date boundary issues
  }
  return isoDate;
}

// Common carrier code mappings
const CARRIER_CODES: Record<string, string> = {
  usps: 'usps',
  ups: 'ups',
  fedex: 'fedex',
  dhl: 'dhl',
  'dhl express': 'dhl',
  ontrac: 'ontrac',
  lasership: 'lasership',
  'canada post': 'canada-post',
  'royal mail': 'royal-mail',
  'australia post': 'australia-post',
  'china post': 'china-post',
  ems: 'china-ems',
  yanwen: 'yanwen',
  'yun express': 'yunexpress',
  'sf express': 'sf-express',
};

export class TrackingMoreClient {
  private apiKey: string;

  constructor(config: TrackingMoreConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Make authenticated API request
   */
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<T> {
    const url = `${API_BASE}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Tracking-Api-Key': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`TrackingMore API error: Invalid JSON response - ${text.substring(0, 200)}`);
    }

    if (!response.ok || data.meta?.code !== 200) {
      const message = data.meta?.message || data.message || 'Unknown error';
      throw new Error(`TrackingMore API error (${data.meta?.code || response.status}): ${message}`);
    }

    return data.data;
  }

  /**
   * Normalize carrier name to TrackingMore carrier code
   */
  private normalizeCarrierCode(carrier: string): string {
    const normalized = carrier.toLowerCase().trim();
    return CARRIER_CODES[normalized] || normalized.replace(/\s+/g, '-');
  }

  /**
   * Track a shipment by tracking number and carrier
   * In API v4, /trackings/create is "create & get" - returns tracking data immediately
   * If tracking already exists, fetches existing data with /trackings/get
   */
  async trackShipment(
    trackingNumber: string,
    carrier: string
  ): Promise<TrackingResult> {
    const carrierCode = this.normalizeCarrierCode(carrier);

    type TrackingResponse = {
      tracking_number: string;
      courier_code: string;
      courier_name?: string;
      delivery_status: string;
      substatus?: string;
      scheduled_delivery_date?: string;
      transit_time?: number;
      origin_country?: string;
      origin_state?: string;
      origin_city?: string;
      destination_country?: string;
      destination_state?: string;
      destination_city?: string;
      origin_info?: {
        courier_phone?: string;
        tracking_link?: string;
        milestone_date?: {
          inforeceived_date?: string;
          pickup_date?: string;
          outfordelivery_date?: string;
          delivery_date?: string;
        };
        trackinfo?: Array<{
          Date?: string;
          checkpoint_date?: string;
          StatusDescription?: string;
          checkpoint_delivery_status?: string;
          Details?: string;
          location?: string;
          status?: string;
        }>;
      };
      destination_info?: {
        trackinfo?: Array<{
          Date?: string;
          checkpoint_date?: string;
          StatusDescription?: string;
          checkpoint_delivery_status?: string;
          Details?: string;
          location?: string;
          status?: string;
        }>;
      };
      latest_event?: string;
      latest_checkpoint_time?: string;
    };

    let result: TrackingResponse;

    try {
      // Try to create tracking (in v4, this also returns tracking data)
      result = await this.request<TrackingResponse>('/trackings/create', 'POST', {
        tracking_number: trackingNumber,
        courier_code: carrierCode,
      });
    } catch (error) {
      // If tracking already exists (4016), fetch existing data
      const message = error instanceof Error ? error.message : '';
      if (message.includes('4101') || message.includes('already exists')) {
        // Fetch existing tracking data - API returns array directly in data
        const items = await this.request<TrackingResponse[]>(
          `/trackings/get?tracking_numbers=${trackingNumber}&courier_code=${carrierCode}`,
          'GET'
        );
        if (!items?.length) {
          throw new Error('Tracking not found');
        }
        result = items[0];
      } else {
        throw error;
      }
    }

    // Parse events from origin and destination info
    const events: TrackingEvent[] = [];
    const originEvents = result.origin_info?.trackinfo || [];
    const destEvents = result.destination_info?.trackinfo || [];

    // Combine and sort events - handle both PascalCase and lowercase field names
    [...originEvents, ...destEvents].forEach((event) => {
      // Try multiple field names for description
      let description = event.StatusDescription || (event as Record<string, unknown>).status_description as string || '';
      const rawDate = event.Date || (event as Record<string, unknown>).date as string || event.checkpoint_date || '';
      const date = normalizeDate(rawDate) || rawDate;
      const location = event.Details || (event as Record<string, unknown>).details as string || event.location || '';
      const status = event.status || (event as Record<string, unknown>).checkpoint_status as string || 'transit';

      // Use checkpoint_delivery_status as description fallback if no description
      if (!description && event.checkpoint_delivery_status) {
        const statusMap: Record<string, string> = {
          transit: 'In Transit',
          pickup: 'Picked Up',
          delivered: 'Delivered',
          undelivered: 'Delivery Failed',
          exception: 'Exception',
          pending: 'Pending',
          inforeceived: 'Shipping Label Created',
        };
        description = statusMap[event.checkpoint_delivery_status] || event.checkpoint_delivery_status;
      }

      if (date) {
        events.push({
          date,
          description,
          location,
          status,
        });
      }
    });

    // Sort events by date descending (newest first)
    events.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    // Determine status
    const status = STATUS_MAP[result.delivery_status] || 'unknown';

    // Get milestone dates from origin_info (normalize to avoid timezone issues)
    const milestones = result.origin_info?.milestone_date;

    // Find shipped and delivered dates - prefer milestone dates, fallback to events
    let shippedAt: string | undefined = normalizeDate(milestones?.pickup_date);
    let deliveredAt: string | undefined = normalizeDate(milestones?.delivery_date);

    // If no milestone dates, try to find from events
    if (!shippedAt || !deliveredAt) {
      for (const event of events) {
        const desc = (event.description || '').toLowerCase();
        if (
          !shippedAt &&
          (desc.includes('picked up') ||
            desc.includes('shipment received') ||
            desc.includes('origin scan'))
        ) {
          shippedAt = event.date;
        }
        if (
          !deliveredAt &&
          (desc.includes('delivered') || status === 'delivered')
        ) {
          deliveredAt = event.date;
        }
      }
    }

    // Build origin/destination strings
    const origin = [result.origin_city, result.origin_state, result.origin_country]
      .filter(Boolean)
      .join(', ');
    const destination = [result.destination_city, result.destination_state, result.destination_country]
      .filter(Boolean)
      .join(', ');

    return {
      trackingNumber: result.tracking_number,
      carrier: result.courier_name || carrier,
      carrierCode: result.courier_code,
      status,
      statusDescription: result.substatus || result.delivery_status,
      estimatedDelivery: normalizeDate(result.scheduled_delivery_date),
      deliveredAt,
      shippedAt,
      labelCreatedAt: normalizeDate(milestones?.inforeceived_date),
      lastUpdate: normalizeDate(result.latest_checkpoint_time),
      origin: origin || undefined,
      destination: destination || undefined,
      events,
    };
  }

  /**
   * Detect carrier from tracking number
   */
  async detectCarrier(trackingNumber: string): Promise<string[]> {
    try {
      const result = await this.request<
        Array<{ courier_code: string; courier_name: string }>
      >('/couriers/detect', 'POST', {
        tracking_number: trackingNumber,
      });

      return result.map((c) => c.courier_code);
    } catch {
      return [];
    }
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      // Try to list available couriers as a simple test
      await this.request('/couriers');
      return { success: true, message: 'Connected to TrackingMore' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to connect',
      };
    }
  }
}

/**
 * Create a TrackingMore client from integration settings
 */
export async function createTrackingMoreClient(): Promise<TrackingMoreClient | null> {
  const { default: prisma } = await import('@/lib/db');
  const { decryptJson } = await import('@/lib/encryption');

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'TRACKINGMORE' },
  });

  if (!settings || !settings.enabled) {
    return null;
  }

  const config = decryptJson<TrackingMoreConfig>(settings.encryptedData);
  return new TrackingMoreClient(config);
}
