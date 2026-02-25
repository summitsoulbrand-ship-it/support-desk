/**
 * SmartyStreets US Address Autocomplete API Proxy
 * Proxies requests to SmartyStreets to keep API keys server-side
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

interface SmartyStreetsConfig {
  authId: string;
  authToken: string;
}

async function getSmartyConfig(): Promise<SmartyStreetsConfig | null> {
  // Try database first
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'SMARTYSTREETS' },
  });

  if (settings?.enabled) {
    try {
      const config = decryptJson<SmartyStreetsConfig>(settings.encryptedData);
      if (config.authId && config.authToken) {
        return config;
      }
    } catch {
      // Fall through to env vars
    }
  }

  // Fallback to environment variables
  const authId = process.env.SMARTY_AUTH_ID;
  const authToken = process.env.SMARTY_AUTH_TOKEN;
  if (authId && authToken) {
    return { authId, authToken };
  }

  return null;
}

interface SmartyStreetsSuggestion {
  street_line: string;
  secondary: string;
  city: string;
  state: string;
  zipcode: string;
  entries: number;
}

interface SmartyStreetsResponse {
  suggestions: SmartyStreetsSuggestion[];
}

export interface AddressSuggestion {
  streetLine: string;
  secondary: string;
  city: string;
  state: string;
  zipcode: string;
  entries: number;
  displayText: string;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const config = await getSmartyConfig();
    if (!config) {
      return NextResponse.json(
        { error: 'SmartyStreets not configured' },
        { status: 503 }
      );
    }

    const search = request.nextUrl.searchParams.get('search') || '';
    const selected = request.nextUrl.searchParams.get('selected');

    if (!search || search.length < 3) {
      return NextResponse.json({ suggestions: [] });
    }

    // Build SmartyStreets API URL
    const params = new URLSearchParams({
      'auth-id': config.authId,
      'auth-token': config.authToken,
      search,
      max_results: '10',
      prefer_geolocation: 'none',
    });

    // If a previous selection was made, include it for secondary address lookup
    if (selected) {
      params.set('selected', selected);
    }

    const url = `https://us-autocomplete-pro.api.smartystreets.com/lookup?${params}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('SmartyStreets API error:', response.status, await response.text());
      return NextResponse.json(
        { error: 'Address lookup failed' },
        { status: response.status }
      );
    }

    const data: SmartyStreetsResponse = await response.json();

    // Transform to our format
    const suggestions: AddressSuggestion[] = (data.suggestions || []).map((s) => ({
      streetLine: s.street_line,
      secondary: s.secondary || '',
      city: s.city,
      state: s.state,
      zipcode: s.zipcode,
      entries: s.entries || 0,
      displayText: formatDisplayText(s),
    }));

    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error('Error in address autocomplete:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function formatDisplayText(s: SmartyStreetsSuggestion): string {
  const parts = [s.street_line];
  if (s.secondary) {
    parts.push(s.secondary);
  }
  parts.push(`${s.city}, ${s.state} ${s.zipcode}`);

  // If there are multiple entries (e.g., apartment building), indicate it
  if (s.entries > 1) {
    return `${parts[0]} (${s.entries} entries), ${parts.slice(1).join(', ')}`;
  }

  return parts.join(', ');
}
