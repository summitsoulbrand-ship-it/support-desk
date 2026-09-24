/**
 * Which shipped fulfillment a replacement parcel's tracking goes on.
 *
 * Almost every order has one, and that is the answer. A split order has one
 * fulfillment per parcel, and the shipping-update email lists the shirts on
 * the fulfillment whose tracking changed - so it has to be the parcel that held
 * the shirt being replaced. #38075 shipped the same design twice (Graphite XL
 * and Blue Jean 2XL, a parcel each) and its reprint was the Graphite XL, which
 * was NOT the newest parcel. So: title and size/color first, then title alone,
 * then the newest shipped fulfillment (what this always picked before).
 */

export interface PickableFulfillment {
  status: string;
  createdAt: string;
  fulfillmentLineItems?: {
    nodes: { lineItem: { title: string | null; variantTitle: string | null } | null }[];
  };
}

export interface ReplacedItem {
  /** Product title as Printify wrote it on the replacement order */
  title?: string;
  /** Printify's variant label, e.g. "Graphite / XL" */
  variantLabel?: string;
}

// A product duplicated in Printify to remake an order reads "Copy of <title>".
const titleKey = (s?: string | null) =>
  (s || '').toLowerCase().replace(/^copy of\s+/, '').replace(/\s+/g, ' ').trim();

// Shopify and Printify can list the options in either order.
const variantKey = (s?: string | null) =>
  (s || '')
    .toLowerCase()
    .split('/')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join('|');

export function pickFulfillmentForTracking<F extends PickableFulfillment>(
  fulfillments: F[],
  items?: ReplacedItem[]
): F | undefined {
  const shipped = fulfillments
    .filter((f) => f.status === 'SUCCESS')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const wanted = (items || []).filter((it) => titleKey(it.title));
  if (shipped.length <= 1 || wanted.length === 0) return shipped[0];

  const lines = (f: F) =>
    (f.fulfillmentLineItems?.nodes || []).flatMap((n) => (n.lineItem ? [n.lineItem] : []));
  const holds = (f: F, withVariant: boolean) =>
    lines(f).some((li) =>
      wanted.some(
        (it) =>
          titleKey(li.title) === titleKey(it.title) &&
          (!withVariant || variantKey(li.variantTitle) === variantKey(it.variantLabel))
      )
    );

  return (
    shipped.find((f) => holds(f, true)) ||
    shipped.find((f) => holds(f, false)) ||
    shipped[0]
  );
}
