/**
 * On-demand tracking API
 * Fetches real-time tracking data from TrackingMore with caching
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createTrackingMoreClient } from '@/lib/trackingmore';
import prisma from '@/lib/db';
import { z } from 'zod';

const trackSchema = z.object({
  trackingNumber: z.string().min(1),
  carrier: z.string().min(1),
  refresh: z.boolean().optional(), // Force refresh from API
});

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { trackingNumber, carrier, refresh } = trackSchema.parse(body);

    // Check cache first (unless refresh requested)
    if (!refresh) {
      const cached = await prisma.trackingCache.findUnique({
        where: {
          trackingNumber_carrier: {
            trackingNumber,
            carrier,
          },
        },
      });

      if (cached) {
        // Return cached data with a flag indicating it's from cache
        const data = cached.data as Record<string, unknown>;
        return NextResponse.json({
          ...data,
          _cached: true,
          _cachedAt: cached.fetchedAt,
        });
      }
    }

    // Fetch from TrackingMore API
    const client = await createTrackingMoreClient();
    if (!client) {
      return NextResponse.json(
        { error: 'TrackingMore integration not configured' },
        { status: 503 }
      );
    }

    const result = await client.trackShipment(trackingNumber, carrier);

    // Save to cache
    await prisma.trackingCache.upsert({
      where: {
        trackingNumber_carrier: {
          trackingNumber,
          carrier,
        },
      },
      create: {
        trackingNumber,
        carrier,
        data: result as object,
        fetchedAt: new Date(),
      },
      update: {
        data: result as object,
        fetchedAt: new Date(),
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('Error fetching tracking:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch tracking' },
      { status: 500 }
    );
  }
}

// GET endpoint to fetch cached tracking data without hitting the API
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const trackingNumber = searchParams.get('trackingNumber');
    const carrier = searchParams.get('carrier');

    if (!trackingNumber || !carrier) {
      return NextResponse.json(
        { error: 'trackingNumber and carrier are required' },
        { status: 400 }
      );
    }

    const cached = await prisma.trackingCache.findUnique({
      where: {
        trackingNumber_carrier: {
          trackingNumber,
          carrier,
        },
      },
    });

    if (!cached) {
      return NextResponse.json({ cached: false });
    }

    return NextResponse.json({
      cached: true,
      data: cached.data,
      fetchedAt: cached.fetchedAt,
    });
  } catch (err) {
    console.error('Error fetching cached tracking:', err);
    return NextResponse.json(
      { error: 'Failed to fetch cached tracking' },
      { status: 500 }
    );
  }
}
