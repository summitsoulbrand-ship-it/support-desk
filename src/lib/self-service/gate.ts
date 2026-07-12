/**
 * Launch gate for the manage-order portal (status page + address/item changes).
 *
 * Until SELF_SERVICE_MANAGE_ENABLED=true, the manage flow is invisible to the
 * public: its APIs 404 and request-link keeps minting the classic cancel/
 * withdraw links. Setting SELF_SERVICE_PREVIEW_KEY lets us exercise the REAL
 * deployed flow privately first (?preview=<key> on requests) - flipping the
 * env var is the launch switch, no deploy needed.
 */

import type { NextRequest } from 'next/server';

export function manageFlowEnabled(): boolean {
  return process.env.SELF_SERVICE_MANAGE_ENABLED === 'true';
}

/** Is this request allowed to use the manage flow (public launch OR preview key)? */
export function manageFlowAllowed(request: NextRequest): boolean {
  if (manageFlowEnabled()) return true;
  const key = process.env.SELF_SERVICE_PREVIEW_KEY;
  if (!key) return false;
  const supplied =
    new URL(request.url).searchParams.get('preview') ||
    request.headers.get('x-preview-key');
  return supplied === key;
}
