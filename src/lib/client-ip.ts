/**
 * Client IP extraction for rate limiting on public endpoints.
 *
 * The app runs behind Railway's edge proxy, which APPENDS the real client IP
 * as the LAST entry of x-forwarded-for. Earlier entries are whatever the
 * client itself sent in its own x-forwarded-for header, so trusting the FIRST
 * entry would let an attacker rotate arbitrary spoofed IPs and sidestep every
 * per-IP rate limit. Prefer the proxy-set x-real-ip when present, otherwise
 * take the LAST x-forwarded-for entry (the one hop we know the proxy added).
 */

import { NextRequest } from 'next/server';

export function clientIp(request: NextRequest): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return 'unknown';
}
