/**
 * POST /api/self-service/address  { token, address }
 *
 * Customer fixes their shipping address before the order goes to print.
 * Same-country only - the country comes from the order, never the customer
 * (a country change alters shipping cost and is a support conversation).
 *
 * Order of operations:
 *  1. re-check LIVE that every Printify copy is still pre-production
 *  2. atomically consume the token
 *  3. update the Shopify address (Shopify also validates it - if it rejects,
 *     nothing else happens)
 *  4. cancel+recreate every live Printify copy with the new address
 *     (recreatePrintifyOrder creates the replacement FIRST and rolls back on
 *     failure, so a sale is never left cancelled without a replacement)
 *  5. verify: re-read the replacement and compare the address field by field,
 *     comparing countries as 2-letter codes ("US" vs "United States" is not a
 *     mismatch)
 *
 * Any failure or unverified result alerts a human. Gated by the launch gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';
import { recreatePrintifyOrder, toCountryCode } from '@/lib/printify/relink';
import {
  getValidToken,
  consumeToken,
  releaseToken,
  issueContinuationToken,
} from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import {
  loadOrderStateForToken,
  reasonMessage,
  hasActiveReroute,
} from '@/lib/self-service/orders';
import { verifyUsAddress } from '@/lib/smartystreets';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import {
  sendSelfServiceSupportNotice,
  sendSelfServiceChangeConfirmation,
} from '@/lib/self-service/email';

const bodySchema = z.object({
  token: z.string().min(1),
  address: z.object({
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    address1: z.string().min(1).max(200),
    address2: z.string().max(200).optional(),
    city: z.string().min(1).max(120),
    zip: z.string().min(1).max(20),
    provinceCode: z.string().max(10).optional(),
    province: z.string().max(80).optional(),
    phone: z.string().max(30).optional(),
  }),
});

const norm = (s?: string | null) => (s || '').trim().toLowerCase();

export async function POST(request: NextRequest) {
  if (!manageFlowAllowed(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const token = await getValidToken(body.token);
  if (!token || token.purpose !== 'MANAGE') {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }

  // LIVE re-check at the moment of action - never trust the rendered page.
  const state = await loadOrderStateForToken(token);
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }
  if (!state.eligibility.eligible) {
    return NextResponse.json(
      { error: reasonMessage(state.eligibility.reason), reason: state.eligibility.reason },
      { status: 409 }
    );
  }

  const currentAddr = state.shopifyOrder.shippingAddress;
  const countryCode = toCountryCode(
    currentAddr?.countryCode || currentAddr?.country
  );
  if (!countryCode) {
    return NextResponse.json(
      { error: 'We could not verify the destination country. Contact support@summitsoul.shop.' },
      { status: 409 }
    );
  }

  // Manually rerouted orders (regional print provider) must not be rebuilt
  // automatically - the recreate would land on the default provider.
  if (await hasActiveReroute(state.shopifyOrder.id)) {
    return NextResponse.json(
      {
        error:
          'This order needs a quick human touch to change - email support@summitsoul.shop and we will update the address for you.',
      },
      { status: 409 }
    );
  }

  // US addresses: verify the address exists AND standardize it before
  // touching anything. Advisory on availability (a verifier outage never
  // blocks), but when Smarty answers we SAVE its corrected form - so a
  // mistyped city like "Huntington Bea" ships as "Huntington Beach", and a
  // genuinely nonexistent address is refused.
  const addr = { ...body.address };
  if (countryCode === 'US') {
    const check = await verifyUsAddress({
      street: addr.address1,
      street2: addr.address2 || undefined,
      city: addr.city,
      state: addr.provinceCode || addr.province || undefined,
      zipcode: addr.zip,
    });
    if (check.verdict === 'invalid') {
      return NextResponse.json(
        {
          error:
            "We couldn't find that address. Please double-check the street, city and ZIP - or email support@summitsoul.shop if it's a brand-new address.",
        },
        { status: 422 }
      );
    }
    if (check.verdict === 'valid' && check.normalized) {
      addr.address1 = check.normalized.street;
      if (check.normalized.street2) addr.address2 = check.normalized.street2;
      addr.city = check.normalized.city;
      addr.provinceCode = check.normalized.state || addr.provinceCode;
      // Keep the 5-digit ZIP the customer expects; Smarty's ZIP+4 is fine too.
      addr.zip = check.normalized.zipcode;
    }
  }

  const claimed = await consumeToken(token.id);
  if (!claimed) {
    return NextResponse.json(
      { error: 'This link has already been used. Request a new one to make another change.' },
      { status: 409 }
    );
  }

  try {
    const shopifyClient = await createShopifyClient();
    if (!shopifyClient) {
      await releaseToken(token.id);
      return NextResponse.json(
        { error: 'Changes are temporarily unavailable. Contact support@summitsoul.shop.' },
        { status: 503 }
      );
    }

    // 1) Shopify first - it validates the address. If it rejects, nothing
    //    anywhere has changed. `addr` is Smarty-standardized for US orders.
    const a = addr;
    const shopifyResult = await shopifyClient.updateOrderShippingAddress(
      state.shopifyOrder.id,
      {
        firstName: a.firstName ?? currentAddr?.firstName,
        lastName: a.lastName ?? currentAddr?.lastName,
        address1: a.address1,
        address2: a.address2 ?? '',
        city: a.city,
        zip: a.zip,
        provinceCode: a.provinceCode || undefined,
        province: a.province || undefined,
        countryCode, // always the ORDER's country - same-country rule
        phone: a.phone ?? currentAddr?.phone,
      }
    );
    if (!shopifyResult.success) {
      await releaseToken(token.id);
      return NextResponse.json(
        {
          error:
            'That address was rejected as undeliverable (' +
            (shopifyResult.errors?.join('; ') || 'validation failed') +
            '). Please double-check it and try again.',
        },
        { status: 422 }
      );
    }

    // 2) Cancel+recreate every live Printify copy with the corrected address.
    const newAddress = {
      first_name: a.firstName ?? currentAddr?.firstName,
      last_name: a.lastName ?? currentAddr?.lastName,
      phone: a.phone ?? currentAddr?.phone,
      country: countryCode,
      // A cleared/omitted state must KEEP the current one, never wipe it -
      // the spread in recreatePrintifyOrder lets an explicit undefined
      // override the original region, and Printify rejects e.g. US addresses
      // without a region.
      region:
        a.provinceCode ||
        a.province ||
        currentAddr?.provinceCode ||
        currentAddr?.province ||
        undefined,
      address1: a.address1,
      address2: a.address2 ?? '',
      city: a.city,
      zip: a.zip,
    };

    const newIds: string[] = [];
    for (const copy of state.printifyOrders) {
      let result: Awaited<ReturnType<typeof recreatePrintifyOrder>>;
      try {
        result = await recreatePrintifyOrder({
          printifyOrderId: copy.id,
          shopifyOrderId: state.shopifyOrder.id,
          shopifyOrderName: token.shopifyOrderName,
          reason: 'ADDRESS_CHANGE',
          newAddress,
        });
      } catch (err) {
        result = {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
      if (!result.success || !result.newPrintifyOrderId) {
        await notifySelfServiceFailure({
          flow: 'address-change',
          orderName: token.shopifyOrderName,
          step: `Recreate Printify order ${copy.id} with the new address`,
          error: result.error || 'recreate failed',
          humanAction:
            `Shopify already has the NEW address${newIds.length ? `; recreated so far: ${newIds.join(', ')}` : ''}. ` +
            `Printify copy ${copy.id} still has the OLD address - apply the change in Printify by hand (recreate aborts safely, so it is still live).`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id, newAddress: { ...newAddress, phone: undefined } },
        });
        // Do NOT release the token - Shopify is already updated; a blind retry
        // would re-run recreates. A human finishes this one.
        return NextResponse.json({
          ok: true,
          message:
            'Your new address is saved. One part of your order needs a quick manual touch on our side - our team has been notified and will finish it today. Nothing else you need to do.',
        });
      }
      newIds.push(result.newPrintifyOrderId);
    }

    // 3) Verify field by field on the replacement copies (countries as codes).
    //    Best-effort: a verify crash must never re-arm the token (the change
    //    already happened) - it just downgrades to "unverified + alert".
    let verified = true;
    if (newIds.length > 0) {
      try {
        const printify = await createPrintifyClient();
        for (const id of newIds) {
          const created = printify ? await printify.getOrder(id) : null;
          const to = created?.address_to;
          const ok =
            !!to &&
            norm(to.address1) === norm(a.address1) &&
            norm(to.city) === norm(a.city) &&
            norm(to.zip) === norm(a.zip) &&
            toCountryCode(to.country) === countryCode;
          if (!ok) verified = false;
        }
      } catch {
        verified = false;
      }
      if (!verified) {
        await notifySelfServiceFailure({
          flow: 'address-change',
          orderName: token.shopifyOrderName,
          step: 'Post-change verification (compare replacement address field by field)',
          error: 'Replacement order address did not read back as expected',
          humanAction: `Open Printify ${newIds.join(', ')} and confirm the ship-to matches: ${a.address1}, ${a.city} ${a.zip} ${countryCode}.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { newIds },
        });
      }
    }

    // 4) Confirmations - never break the success path.
    await sendSelfServiceChangeConfirmation({
      to: state.shopifyOrder.customerEmail || token.email,
      orderName: token.shopifyOrderName,
      heading: 'Shipping address updated',
      changeSummary: `Your order ${token.shopifyOrderName} will now ship to: ${a.address1}${a.address2 ? ', ' + a.address2 : ''}, ${a.city} ${a.zip}.`,
    }).catch((e) => console.error('[self-service/address] confirmation failed:', e));

    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_address_change',
      summary: `Customer self-changed shipping address on ${token.shopifyOrderName} (${newIds.length} Printify cop${newIds.length === 1 ? 'y' : 'ies'} recreated${verified ? ', verified' : ', VERIFY FAILED'})`,
      orderName: token.shopifyOrderName,
      metadata: {
        shopifyOrderId: state.shopifyOrder.id,
        newPrintifyOrderIds: newIds,
        verified,
        requestIp: token.requestIp,
      },
    }).catch(() => undefined);

    await sendSelfServiceSupportNotice({
      orderName: token.shopifyOrderName,
      customerEmail: state.shopifyOrder.customerEmail || token.email,
      action: `Address changed (self-service)${verified ? '' : ' - VERIFY FAILED, see alert'}`,
      printifyCancelled: newIds.length > 0,
      total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
      requestIp: token.requestIp,
      shopifyOrderId: state.shopifyOrder.id,
      printifyOrderId: newIds[0] || state.printifyOrderId,
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      message:
        'Done - your shipping address has been updated on your order. A confirmation email is on its way.',
      nextToken: await issueContinuationToken(token),
    });
  } catch (err) {
    console.error('[self-service/address] execution error:', err);
    await notifySelfServiceFailure({
      flow: 'address-change',
      orderName: token.shopifyOrderName,
      step: 'Unexpected crash during address change',
      error: err instanceof Error ? err.message : 'Unknown error',
      humanAction:
        'Check the address on BOTH Shopify and Printify - the change may have half-completed.',
      customerEmail: token.email,
      detail: { shopifyOrderId: token.shopifyOrderId },
    });
    // Deliberately NOT releasing the token: the crash may have landed after
    // Shopify was updated and copies were recreated, and a blind retry would
    // cancel+recreate the fresh replacements all over again. A human finishes.
    return NextResponse.json(
      {
        error:
          'Something went wrong partway through. Our team has been alerted and will finish your change by hand - no action needed on your side.',
      },
      { status: 500 }
    );
  }
}
