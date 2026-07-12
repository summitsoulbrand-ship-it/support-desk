/**
 * GET /api/self-service/address-suggest?token=...&search=...&selected=...
 *
 * US address type-ahead for the portal's address form, proxying SmartyStreets
 * so the key stays server-side. Requires a valid (unconsumed) MANAGE token -
 * only customers mid-flow can burn suggestion quota - plus the launch gate
 * and a per-IP rate limit. Returns { suggestions: [] } on any failure; the
 * form degrades to plain typing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimitAsync } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { getValidToken } from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import { suggestUsAddresses } from '@/lib/smartystreets';

export async function GET(request: NextRequest) {
  if (!manageFlowAllowed(request)) {
    return NextResponse.json({ suggestions: [] }, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const token = await getValidToken(params.get('token') || '');
  if (!token || token.purpose !== 'MANAGE') {
    return NextResponse.json({ suggestions: [] }, { status: 400 });
  }

  const ip = clientIp(request);
  const limit = await checkRateLimitAsync(`ss-suggest-ip:${ip}`, 60, 15 * 60 * 1000);
  if (!limit.success) {
    return NextResponse.json({ suggestions: [] }, { status: 429 });
  }

  const search = (params.get('search') || '').slice(0, 120);
  const selected = params.get('selected');
  const suggestions = await suggestUsAddresses(search, selected);
  return NextResponse.json({ suggestions });
}
