import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

/**
 * One app, several hostnames. The customer-facing ones must never drop a
 * shopper on the staff login: anyone typing the bare selfservice/account
 * domain wants to look up their order, not sign in. Staff hostnames (the
 * Railway app URL, localhost) keep landing on the inbox.
 *
 * Extend the customer list with SELF_SERVICE_HOSTS (comma-separated) rather
 * than editing this file when a domain is added.
 */
const CUSTOMER_HOSTS = new Set(
  [
    'selfservice.summitsoul.shop',
    ...(process.env.SELF_SERVICE_HOSTS || '').split(','),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

export default async function Home() {
  const headerList = await headers();
  // x-forwarded-host is what Railway's proxy sets; host is the direct fallback.
  const host = (headerList.get('x-forwarded-host') || headerList.get('host') || '')
    .split(':')[0]
    .toLowerCase();

  redirect(CUSTOMER_HOSTS.has(host) ? '/self-service/order' : '/inbox');
}
