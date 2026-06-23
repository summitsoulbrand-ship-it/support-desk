/**
 * Should a draft pull LIVE carrier tracking? Live tracking calls (TrackingMore,
 * DHL) are slow, so we only make them when the reply actually needs shipping
 * truth: the intent is a shipping question, or the customer's message mentions
 * shipping / tracking / delivery. A generic order issue (wrong size, defect,
 * cancellation, product question) does NOT need a live carrier call - cached
 * tracking is still attached, it just is not refreshed. This keeps the common
 * draft fast instead of waiting on the carrier API every time.
 */

const SHIPPING_KEYWORDS =
  /track|where('?s| is)|ship(ped|ping)|arriv|deliver|lost|never (arrived|came|got|received)|missing|stolen|en route|on its way|hasn'?t (arrived|come|shipped)|status of (my|the) order/;

export function needsLiveTracking(
  intent: string | null | undefined,
  customerText: string | null | undefined
): boolean {
  if (intent === 'SHIPPING_STATUS') return true;
  return SHIPPING_KEYWORDS.test((customerText || '').toLowerCase());
}
