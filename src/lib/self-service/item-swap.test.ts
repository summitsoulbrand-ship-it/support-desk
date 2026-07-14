/**
 * Batch Printify line mapping - the multi-item #27253 protection. Every case
 * here is "the right design gets the right swap, others untouched, ambiguity
 * fails closed."
 */

import { describe, it, expect } from 'vitest';
import { mapPrintifySwap, type SwapMapInput } from './item-swap';
import type { PrintifyClient } from '@/lib/printify';
import type { PrintifyOrder } from '@/lib/printify/types';

// A tiny fake catalog: two designs, each with S/M/L in one color.
const PRODUCTS: Record<string, { title: string; variants: { id: number; title: string; is_enabled: boolean }[] }> = {
  bison: {
    title: 'Lone Bison',
    variants: [
      { id: 11, title: 'Black / S', is_enabled: true },
      { id: 12, title: 'Black / M', is_enabled: true },
      { id: 13, title: 'Black / L', is_enabled: true },
    ],
  },
  owl: {
    title: 'Night Owl',
    variants: [
      { id: 21, title: 'Blue / S', is_enabled: true },
      { id: 22, title: 'Blue / M', is_enabled: true },
      { id: 23, title: 'Blue / L', is_enabled: true },
    ],
  },
};

const fakePrintify = {
  getProduct: async (id: string) => PRODUCTS[id],
} as unknown as PrintifyClient;

function order(lines: { product_id: string; variant_id: number; title: string }[]): PrintifyOrder {
  return {
    line_items: lines.map((l) => ({
      product_id: l.product_id,
      variant_id: l.variant_id,
      quantity: 1,
      metadata: { title: l.title },
    })),
  } as unknown as PrintifyOrder;
}

const change = (over: Partial<SwapMapInput>): SwapMapInput => ({
  itemTitle: 'Lone Bison',
  oldVariantTitle: 'Black / M',
  newVariantTitle: 'Black / L',
  quantity: 1,
  ...over,
});

describe('mapPrintifySwap (batch)', () => {
  it('single change swaps the right line, keeps the other verbatim', async () => {
    const o = order([
      { product_id: 'bison', variant_id: 12, title: 'Lone Bison' }, // Black/M
      { product_id: 'owl', variant_id: 22, title: 'Night Owl' }, // Blue/M
    ]);
    const map = await mapPrintifySwap(fakePrintify, o, [change({})]);
    expect(map).not.toBeNull();
    expect(map!.desiredLines).toEqual([
      { product_id: 'bison', variant_id: 13, quantity: 1 }, // Bison -> Black/L
      { product_id: 'owl', variant_id: 22, quantity: 1 }, // Owl untouched
    ]);
  });

  it('two changes on distinct designs both land correctly', async () => {
    const o = order([
      { product_id: 'bison', variant_id: 12, title: 'Lone Bison' },
      { product_id: 'owl', variant_id: 22, title: 'Night Owl' },
    ]);
    const map = await mapPrintifySwap(fakePrintify, o, [
      change({ itemTitle: 'Lone Bison', oldVariantTitle: 'Black / M', newVariantTitle: 'Black / S' }),
      change({ itemTitle: 'Night Owl', oldVariantTitle: 'Blue / M', newVariantTitle: 'Blue / L' }),
    ]);
    expect(map!.desiredLines).toEqual([
      { product_id: 'bison', variant_id: 11, quantity: 1 }, // Black/S
      { product_id: 'owl', variant_id: 23, quantity: 1 }, // Blue/L
    ]);
  });

  it('shared old label across designs: title affinity picks the right one', async () => {
    // Both lines are "... / M" but different designs; changing the Owl must
    // not touch the Bison.
    const o = order([
      { product_id: 'bison', variant_id: 12, title: 'Lone Bison' }, // Black/M
      { product_id: 'owl', variant_id: 22, title: 'Night Owl' }, // Blue/M
    ]);
    const map = await mapPrintifySwap(fakePrintify, o, [
      change({ itemTitle: 'Night Owl', oldVariantTitle: 'Blue / M', newVariantTitle: 'Blue / S' }),
    ]);
    expect(map!.desiredLines).toEqual([
      { product_id: 'bison', variant_id: 12, quantity: 1 }, // untouched
      { product_id: 'owl', variant_id: 21, quantity: 1 }, // Blue/S
    ]);
  });

  it('two identical lines, two different changes -> distinct lines each', async () => {
    const o = order([
      { product_id: 'bison', variant_id: 12, title: 'Lone Bison' },
      { product_id: 'bison', variant_id: 12, title: 'Lone Bison' },
    ]);
    // Both changes have the same old label + title; each must claim a distinct line.
    const map = await mapPrintifySwap(fakePrintify, o, [
      change({ newVariantTitle: 'Black / S' }),
      change({ newVariantTitle: 'Black / L' }),
    ]);
    expect(map).not.toBeNull();
    const ids = map!.desiredLines.map((l) => l.variant_id).sort();
    expect(ids).toEqual([11, 13]); // one to S, one to L - distinct
  });

  it('new variant not on the product -> null (fail closed)', async () => {
    const o = order([{ product_id: 'bison', variant_id: 12, title: 'Lone Bison' }]);
    const map = await mapPrintifySwap(fakePrintify, o, [
      change({ newVariantTitle: 'Black / XXXL' }),
    ]);
    expect(map).toBeNull();
  });

  it('old label matches no line -> null', async () => {
    const o = order([{ product_id: 'bison', variant_id: 12, title: 'Lone Bison' }]);
    const map = await mapPrintifySwap(fakePrintify, o, [
      change({ oldVariantTitle: 'Black / XL' }),
    ]);
    expect(map).toBeNull();
  });

  it('empty change list -> null', async () => {
    const o = order([{ product_id: 'bison', variant_id: 12, title: 'Lone Bison' }]);
    expect(await mapPrintifySwap(fakePrintify, o, [])).toBeNull();
  });
});
