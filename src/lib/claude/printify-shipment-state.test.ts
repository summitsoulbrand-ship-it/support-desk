import { describe, it, expect } from 'vitest';
import { buildPrintifyContext, type SuggestionContext } from './types';
import { ClaudeService } from './service';
import type { PrintifyOrder } from '@/lib/printify/types';

/**
 * Printify flips the ORDER to shipment_in_transit and issues the tracking
 * number the moment the parcel leaves the print shop - routinely a day or more
 * before the carrier's first scan. The old context summarized production from
 * LINE ITEMS only, so that order-level fact never reached the draft, and the
 * only shipping sentence in the prompt was the carrier's "label created, not
 * picked up". Result: order #32796 (Pati, 2026-08-09) - a customer holding a
 * DHL tracking number was told her order had not shipped.
 */
const shipped = (overrides: Partial<PrintifyOrder> = {}): PrintifyOrder =>
  ({
    id: 'pf_1',
    status: 'shipment_in_transit',
    line_items: [{ status: 'fulfilled', metadata: { title: 'Fluffy Cow V-Neck' } }],
    shipments: [
      {
        carrier: 'DHL eCommerce',
        number: '420291279261290316842736859072',
        url: 'https://example.test/track',
      },
    ],
    ...overrides,
  }) as unknown as PrintifyOrder;

const promptFor = (context: SuggestionContext) =>
  (
    new ClaudeService({ apiKey: 'test-key' }) as unknown as {
      buildUserMessage: (c: SuggestionContext) => string;
    }
  ).buildUserMessage(context);

const contextWith = (order: PrintifyOrder): SuggestionContext => ({
  messages: [],
  ...buildPrintifyContext(order),
  trackingInfo: {
    // What the carrier said while the parcel sat unscanned.
    status: 'Label created - NOT shipped yet (carrier has not picked it up)',
    carrier: 'DHL eCommerce',
    trackingNumber: '420291279261290316842736859072',
    isDelivered: false,
    hasShipped: false,
  },
});

describe('Printify shipment state in the draft context', () => {
  it('carries the order-level status, not just the line items', () => {
    const ctx = buildPrintifyContext(shipped());
    expect(ctx.printifyOrder?.statusLabel).toBe('On the Way');
    expect(ctx.printifyOrder?.productionStatus).toBe('On the Way');
    expect(ctx.printifyOrder?.handedToCarrier).toBe(true);
  });

  it('does not claim a hand-off when Printify has no shipment yet', () => {
    const ctx = buildPrintifyContext(
      shipped({ status: 'in-production', shipments: [] } as Partial<PrintifyOrder>)
    );
    expect(ctx.printifyOrder?.handedToCarrier).toBe(false);
  });

  it('survives a payload with no line_items', () => {
    const ctx = buildPrintifyContext(
      shipped({ line_items: undefined } as unknown as Partial<PrintifyOrder>)
    );
    expect(ctx.printifyOrder?.statusLabel).toBe('On the Way');
  });

  it('tells the draft to reconcile Printify against the carrier', () => {
    const prompt = promptFor(contextWith(shipped()));
    expect(prompt).toContain('RECONCILE THE TWO SOURCES');
    expect(prompt).toContain('On the Way');
    expect(prompt).toContain('Do NOT say it has not shipped');
  });

  it('stays quiet when the carrier already has the package', () => {
    const ctx = contextWith(shipped());
    ctx.trackingInfo!.hasShipped = true;
    ctx.trackingInfo!.status = 'Shipped, on the way';
    expect(promptFor(ctx)).not.toContain('RECONCILE THE TWO SOURCES');
  });

  it('stays quiet when Printify has not created a shipment either', () => {
    const ctx = contextWith(
      shipped({ status: 'in-production', shipments: [] } as Partial<PrintifyOrder>)
    );
    expect(promptFor(ctx)).not.toContain('RECONCILE THE TWO SOURCES');
  });
});
