/**
 * Best-effort Shopify match for a comment author - NAME-based, so it is a
 * labeled guess, never an identity claim. Activates once Meta returns real
 * commenter names (until then authors are "Unknown"/"Facebook user").
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getSession } from '@/lib/auth';
import { createShopifyClient } from '@/lib/shopify';

const PLACEHOLDER_NAMES = new Set(['unknown', 'facebook user', 'instagram user']);

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await context.params;

    const comment = await prisma.socialComment.findUnique({
      where: { id },
      select: { authorName: true },
    });
    if (!comment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const name = (comment.authorName || '').trim();
    const parts = name.split(/\s+/).filter((p) => p.length >= 2);
    if (
      PLACEHOLDER_NAMES.has(name.toLowerCase()) ||
      parts.length < 2 ||
      name.length < 5
    ) {
      return NextResponse.json({ match: null, reason: 'no usable name' });
    }

    const shopify = await createShopifyClient();
    if (!shopify) {
      return NextResponse.json({ match: null, reason: 'shopify not configured' });
    }

    const customer = await shopify.findCustomerByName(name);
    if (!customer) {
      return NextResponse.json({ match: null, reason: 'no customer match' });
    }

    // Strict verification: at least one name part must match exactly,
    // mirroring the email-side name matching rules
    const matchedName = (
      customer.displayName ||
      `${customer.firstName || ''} ${customer.lastName || ''}`
    )
      .toLowerCase()
      .trim();
    const matchedParts = matchedName.split(/\s+/);
    const searchParts = name.toLowerCase().split(/\s+/);
    const hasExactPart = searchParts.some(
      (sp) => sp.length >= 2 && matchedParts.includes(sp)
    );
    if (!hasExactPart) {
      return NextResponse.json({ match: null, reason: 'name mismatch' });
    }

    const orders = await shopify.getCustomerOrders(customer.id, 3);
    if (orders.length === 0) {
      return NextResponse.json({ match: null, reason: 'no orders' });
    }

    return NextResponse.json({
      match: {
        customerName: customer.displayName,
        orders: orders.map((o) => ({
          name: o.name,
          createdAt: o.createdAt,
          fulfillmentStatus: o.fulfillmentStatus,
          items: o.lineItems
            .slice(0, 3)
            .map((li) => `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''} x${li.quantity}`),
        })),
      },
    });
  } catch (err) {
    console.error('Comment order match failed:', err);
    return NextResponse.json({ match: null, reason: 'error' });
  }
}
