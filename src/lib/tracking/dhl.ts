/**
 * Live carrier truth from DHL's official Shipment Tracking API (free tier,
 * 250 calls/day). Called ON-DEMAND only - when a draft is being written for
 * a shipping-status or lost-package inquiry - never in background loops.
 * Returns null when no DHL_API_KEY is configured or the number is unknown.
 */

interface DhlLiveTracking {
  statusCode: string; // pre-transit | transit | delivered | failure | unknown
  statusText: string;
  timestamp?: string;
  location?: string;
  estimatedDelivery?: string;
  proofOfDeliveryUrl?: string;
  events: { timestamp: string; description: string; location?: string }[];
}

const cache = new Map<string, { at: number; data: DhlLiveTracking | null }>();
const CACHE_MS = 15 * 60 * 1000;

export async function fetchDhlLiveTracking(
  trackingNumber: string
): Promise<DhlLiveTracking | null> {
  const apiKey = process.env.DHL_API_KEY;
  if (!apiKey || !trackingNumber) return null;

  const hit = cache.get(trackingNumber);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  try {
    const res = await fetch(
      `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`,
      // Bound the call: a slow/hanging DHL API must not stall the whole draft or
      // address-save (this runs in the serial live-context build). On timeout we
      // degrade to cached/other-source tracking.
      { headers: { 'DHL-API-Key': apiKey }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) {
      cache.set(trackingNumber, { at: Date.now(), data: null });
      return null;
    }
    const data = (await res.json()) as {
      shipments?: Array<{
        status?: {
          statusCode?: string;
          status?: string;
          description?: string;
          timestamp?: string;
          location?: { address?: { addressLocality?: string } };
        };
        estimatedTimeOfDelivery?: string;
        details?: {
          proofOfDelivery?: { documentUrl?: string; signatureUrl?: string };
        };
        events?: Array<{
          timestamp?: string;
          description?: string;
          location?: { address?: { addressLocality?: string } };
        }>;
      }>;
    };

    const shipment = data.shipments?.[0];
    if (!shipment) {
      cache.set(trackingNumber, { at: Date.now(), data: null });
      return null;
    }

    const result: DhlLiveTracking = {
      statusCode: shipment.status?.statusCode || 'unknown',
      statusText:
        shipment.status?.description || shipment.status?.status || 'unknown',
      timestamp: shipment.status?.timestamp,
      location: shipment.status?.location?.address?.addressLocality,
      estimatedDelivery: shipment.estimatedTimeOfDelivery,
      proofOfDeliveryUrl:
        shipment.details?.proofOfDelivery?.documentUrl ||
        shipment.details?.proofOfDelivery?.signatureUrl,
      events: (shipment.events || []).slice(0, 5).map((e) => ({
        timestamp: e.timestamp || '',
        description: e.description || '',
        location: e.location?.address?.addressLocality,
      })),
    };
    cache.set(trackingNumber, { at: Date.now(), data: result });
    return result;
  } catch (err) {
    console.error('DHL live tracking failed:', err);
    return null;
  }
}
