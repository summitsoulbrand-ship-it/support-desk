/**
 * SmartyStreets shared helpers: config lookup (DB first, env fallback),
 * US autocomplete suggestions, and US street-address VERIFICATION.
 *
 * Verification is advisory-by-design: a Smarty outage or missing config must
 * never block a customer (Shopify + Printify still validate basics), so
 * verifyUsAddress returns 'unknown' on any infrastructure failure and only
 * 'invalid' when Smarty positively found no such address.
 */

import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

export interface SmartyConfig {
  authId: string;
  authToken: string;
}

export async function getSmartyConfig(): Promise<SmartyConfig | null> {
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'SMARTYSTREETS' },
  });

  if (settings?.enabled) {
    try {
      const config = decryptJson<SmartyConfig>(settings.encryptedData);
      if (config.authId && config.authToken) {
        return config;
      }
    } catch {
      // Fall through to env vars
    }
  }

  const authId = process.env.SMARTY_AUTH_ID;
  const authToken = process.env.SMARTY_AUTH_TOKEN;
  if (authId && authToken) {
    return { authId, authToken };
  }

  return null;
}

export interface SmartySuggestion {
  streetLine: string;
  secondary: string;
  city: string;
  state: string;
  zipcode: string;
  entries: number;
}

/** US autocomplete (us-autocomplete-pro). Returns [] on any failure. */
export async function suggestUsAddresses(
  search: string,
  selected?: string | null
): Promise<SmartySuggestion[]> {
  if (!search || search.length < 3) return [];
  const config = await getSmartyConfig();
  if (!config) return [];

  try {
    const params = new URLSearchParams({
      'auth-id': config.authId,
      'auth-token': config.authToken,
      search,
      max_results: '8',
      prefer_geolocation: 'none',
    });
    if (selected) params.set('selected', selected);

    const res = await fetch(
      `https://us-autocomplete-pro.api.smartystreets.com/lookup?${params}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      suggestions?: {
        street_line: string;
        secondary?: string;
        city: string;
        state: string;
        zipcode: string;
        entries?: number;
      }[];
    };
    return (data.suggestions || []).map((s) => ({
      streetLine: s.street_line,
      secondary: s.secondary || '',
      city: s.city,
      state: s.state,
      zipcode: s.zipcode,
      entries: s.entries || 0,
    }));
  } catch (err) {
    console.warn('[smartystreets] autocomplete failed:', err);
    return [];
  }
}

export type UsAddressVerdict = 'valid' | 'invalid' | 'unknown';

/**
 * Verify a US address exists (us-street API, match=enhanced considers an
 * address deliverable-checkable). 'invalid' ONLY when Smarty answered and
 * found nothing - infrastructure failures return 'unknown' (do not block).
 */
export async function verifyUsAddress(addr: {
  street: string;
  street2?: string;
  city: string;
  state?: string;
  zipcode: string;
}): Promise<UsAddressVerdict> {
  const config = await getSmartyConfig();
  if (!config) return 'unknown';

  try {
    const params = new URLSearchParams({
      'auth-id': config.authId,
      'auth-token': config.authToken,
      street: addr.street,
      city: addr.city,
      zipcode: addr.zipcode,
      candidates: '1',
    });
    if (addr.street2) params.set('secondary', addr.street2);
    if (addr.state) params.set('state', addr.state);

    const res = await fetch(
      `https://us-street.api.smartystreets.com/street-address?${params}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) {
      console.warn('[smartystreets] verify HTTP error:', res.status);
      return 'unknown';
    }
    const candidates = (await res.json()) as unknown[];
    return Array.isArray(candidates) && candidates.length > 0
      ? 'valid'
      : 'invalid';
  } catch (err) {
    console.warn('[smartystreets] verify failed:', err);
    return 'unknown';
  }
}
