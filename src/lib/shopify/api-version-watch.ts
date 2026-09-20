/**
 * Shopify API version watch.
 *
 * Shopify retires an Admin API version about 12 months after release and then
 * answers on the oldest version still alive. It sends NO error: HTTP 200, a
 * normal body, and the only trace is the response header X-Shopify-API-Version.
 * The old '2025-07' pin ran as 2025-10 for months and nobody saw it, which is
 * how a rule that only exists on the newer version (refundCreate needs
 * @idempotent from 2026-04) nearly broke every refund. This makes it loud.
 *
 * Measured 2026-09-19 against the live store, GraphQL and REST alike:
 *  - asked 2026-07 (supported)        -> header '2026-07'
 *  - asked 2025-07 / 2025-01 (retired) -> HTTP 200, header '2025-10'
 *  - asked 2030-01 (does not exist)   -> HTTP 404 and NO header, so a pin that
 *    is too new already fails loudly by itself and a mismatch means "retired".
 *
 * Rules this file must never break:
 *  - never throw, and never make a Shopify call wait: the check is a header
 *    read, and Slack is fired without being awaited
 *  - a missing header is not news - say nothing
 *  - once per PROCESS. The desk makes thousands of Shopify calls; the web
 *    service and the worker each say it once per restart.
 */

import { postToSlack } from '@/lib/slack';

const VERSION_HEADER = 'x-shopify-api-version';
const CHECK_KIT = '~/Summit Soul AI/automation/shopify_api_check/';
const PIN_FILE = '~/support-desk/src/lib/shopify/client.ts';
const DATED_VERSION = /^\d{4}-\d{2}$/;

// On globalThis, not a module variable: Next can load one module more than once
// inside a single process (separate server bundles), and a module variable
// would then alert once per copy. Same trick as the Prisma client in lib/db.
const processState = globalThis as unknown as {
  __shopifyApiVersionAlerted?: boolean;
};

/** Anything with response headers. Loose on purpose: test fakes often have none. */
type WithHeaders =
  | { headers?: { get?: (name: string) => unknown } | null }
  | null
  | undefined;

/**
 * Compare the version Shopify answered on with the one the desk asked for, and
 * raise it once per process when they differ. Safe to call on every response.
 */
export function watchShopifyApiVersion(response: WithHeaders, requested: string): void {
  try {
    const raw = response?.headers?.get?.(VERSION_HEADER);
    if (typeof raw !== 'string') return;
    const answered = raw.trim();
    if (!answered) return;
    if (answered.toLowerCase() === requested.trim().toLowerCase()) return;

    if (processState.__shopifyApiVersionAlerted) return;
    // Set BEFORE posting: many calls are in flight at once, and every one of
    // them lands here with the same mismatch.
    processState.__shopifyApiVersionAlerted = true;

    const lines = describeMismatch(requested, answered);
    console.warn(`[shopify-api-version] ${lines.join('\n')}`);

    const [headline, ...rest] = lines;
    void postToSlack([`:rotating_light: *${headline}*`, ...rest].join('\n'))
      .then((delivered) => {
        if (!delivered) {
          // postToSlack is false when the webhook is unset or Slack refused it.
          console.error(
            '[shopify-api-version] the Slack alert was NOT delivered - nobody has been told about the version mismatch above'
          );
        }
      })
      .catch(() => undefined);
  } catch {
    // The watch must never be the reason a Shopify call fails.
  }
}

function describeMismatch(requested: string, answered: string): string[] {
  // Dated versions sort as text. Retirement only ever moves the answer FORWARD,
  // so anything else is not the known pattern and must not be called retirement.
  const fellForward =
    DATED_VERSION.test(requested) && DATED_VERSION.test(answered) && answered > requested;
  const service = process.env.RAILWAY_SERVICE_NAME;

  return [
    fellForward
      ? 'Shopify retired the API version the support desk is pinned to'
      : 'Shopify is answering the support desk on a different API version than it asked for',
    `The desk asked Shopify for version ${requested}. Shopify answered with version ${answered}.`,
    fellForward
      ? `That means ${requested} was retired. Shopify sends no error for a retired version. It quietly answers on the oldest version still alive, so new Shopify rules can start applying to refunds, cancellations and order edits with no warning.`
      : `This is not the usual pattern (a retired version is answered with a NEWER one), so the cause is not known yet. Treat it the same way until it is.`,
    `What to do: run the check kit at \`${CHECK_KIT}\` (its README has the run order) BEFORE moving the desk to a newer version. The version is pinned as API_VERSION in \`${PIN_FILE}\`.`,
    `Noticed by ${service || 'a process with no Railway service name'}. Each service says this once per restart, so expect one from the desk and one from the worker.`,
  ];
}

/** Test-only: forget that this process already alerted. */
export function resetShopifyApiVersionWatchForTests(): void {
  delete processState.__shopifyApiVersionAlerted;
}
