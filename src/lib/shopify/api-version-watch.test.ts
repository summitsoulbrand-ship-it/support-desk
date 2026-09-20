/**
 * Shopify API version watch. A retired version is answered with HTTP 200 on a
 * NEWER version and the only trace is a response header - the desk ran on
 * 2025-10 while asking for 2025-07 and nobody knew. These prove the mismatch is
 * raised, raised ONCE, and can never break or delay a Shopify call.
 */

import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest';
import { ShopifyClient } from './client';
import { resetShopifyApiVersionWatchForTests, watchShopifyApiVersion } from './api-version-watch';

const SLACK_URL = 'https://hooks.slack.com/triggers/T/1/escalations';
const RETIRED_ANSWER = '2099-01';

type Answer = (asked: string) => unknown;

/** Shopify's header, the way the real API sends it. */
const versionHeader = (version: string) => new Headers({ 'X-Shopify-API-Version': version });
const sameVersion: Answer = (asked) => versionHeader(asked);
const newerVersion: Answer = () => versionHeader(RETIRED_ANSWER);
const noSuchHeader: Answer = () => new Headers({ 'Content-Type': 'application/json' });

/**
 * A fake Shopify AND a fake Slack on one stubbed fetch. Each answer decides the
 * response `headers` from the version the desk asked for (read off the URL, so
 * nothing here goes stale at the next pin bump); `undefined` leaves the
 * response with no `headers` at all, like the older fakes in this repo.
 */
function fakeWorld(opts: {
  graphql: Answer;
  rest?: Answer;
  status?: number;
  slack?: () => Promise<unknown>;
}) {
  const slackPosts: string[] = [];
  const asked: string[] = [];
  const slackReply = opts.slack ?? (async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }));
  const status = opts.status ?? 200;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      if (url === SLACK_URL) {
        slackPosts.push(JSON.parse(init.body as string).text);
        return slackReply();
      }
      const version = url.match(/\/admin\/api\/([^/]+)\//)?.[1] ?? '';
      asked.push(version);
      const isRest = url.endsWith('/shipping_zones.json');
      const headers = (isRest ? opts.rest ?? opts.graphql : opts.graphql)(version);
      const body = isRest
        ? {
            shipping_zones: [
              {
                id: 1,
                name: 'Domestic',
                countries: [{ id: 1, name: 'United States', code: 'US' }],
                price_based_shipping_rates: [{ id: 7, name: 'Standard', price: '4.95' }],
              },
            ],
          }
        : { data: { shop: { name: 'Summit Soul', currencyCode: 'USD' } } };
      return {
        ok: status >= 200 && status < 300,
        status,
        ...(headers === undefined ? {} : { headers }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    })
  );
  return { slackPosts, asked };
}

const client = () => new ShopifyClient({ storeDomain: 'example.myshopify.com', accessToken: 't' } as never);

/** The Slack post is fire-and-forget, so give it room to happen before judging silence. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
/** Everything a console spy was told, as one string. */
const said = (spy: MockInstance<typeof console.warn>) =>
  spy.mock.calls.map((call) => String(call[0])).join(' ');

beforeEach(() => {
  resetShopifyApiVersionWatchForTests();
  vi.stubEnv('SLACK_ESCALATION_WEBHOOK_URL', SLACK_URL);
  vi.stubEnv('RAILWAY_SERVICE_NAME', 'support-desk-worker');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetShopifyApiVersionWatchForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Shopify API version watch', () => {
  it('alerts once when Shopify answers on a different version than the desk asked for', async () => {
    const world = fakeWorld({ graphql: newerVersion });
    const res = await client().testConnection();
    await settle();

    // The Shopify call itself is untouched.
    expect(res).toEqual({ success: true });

    const pinned = world.asked[0];
    expect(pinned).toMatch(/^\d{4}-\d{2}$/);
    expect(world.slackPosts).toHaveLength(1);
    const [post] = world.slackPosts;
    // Everything a person needs to act on it, in plain words.
    expect(post).toContain(`asked Shopify for version ${pinned}`);
    expect(post).toContain(`answered with version ${RETIRED_ANSWER}`);
    expect(post).toContain(`${pinned} was retired`);
    expect(post).toContain('~/Summit Soul AI/automation/shopify_api_check/');
    expect(post).toContain('README has the run order');
    expect(post).toContain('BEFORE moving the desk to a newer version');
    expect(post).toContain('support-desk-worker');
    // Brand rule: never an em dash.
    expect(post).not.toContain(String.fromCharCode(0x2014));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(said(warn)).toContain(pinned);
    expect(said(warn)).toContain(RETIRED_ANSWER);
    // Delivered, so no "nobody has been told" line.
    expect(error).not.toHaveBeenCalled();
  });

  it('stays quiet when Shopify answers on the version the desk asked for', async () => {
    const world = fakeWorld({ graphql: sameVersion });
    expect(await client().testConnection()).toEqual({ success: true });
    expect((await client().getShippingRatesForCountry('US')).rates).toHaveLength(1);
    await settle();

    expect(world.asked.length).toBeGreaterThan(0);
    expect(world.slackPosts).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the header is missing, or the response has no headers at all', async () => {
    for (const graphql of [noSuchHeader, () => undefined, () => null, () => ({})] as Answer[]) {
      const world = fakeWorld({ graphql });
      expect(await client().testConnection()).toEqual({ success: true });
      expect((await client().getShippingRatesForCountry('US')).rates).toHaveLength(1);
      await settle();
      expect(world.slackPosts).toHaveLength(0);
    }
    // An empty or blank header is "missing" too, not a mismatch.
    const blank = fakeWorld({ graphql: () => ({ get: () => '   ' }) });
    expect(await client().testConnection()).toEqual({ success: true });
    await settle();
    expect(blank.slackPosts).toHaveLength(0);

    expect(warn).not.toHaveBeenCalled();
  });

  it('fires only once across many calls, in a row and at the same time', async () => {
    const world = fakeWorld({ graphql: newerVersion });
    for (let i = 0; i < 25; i++) await client().testConnection();
    await Promise.all(Array.from({ length: 100 }, () => client().getShopCurrencyCode()));
    await Promise.all(Array.from({ length: 25 }, () => client().getShippingRatesForCountry('US')));
    await settle();

    // 25 + 100 + 25 REST + 25 currency reads behind the REST call.
    expect(world.asked).toHaveLength(175);
    expect(world.slackPosts).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('covers the REST shipping-zones call, not just GraphQL', async () => {
    // GraphQL matches here, so only the REST response can have raised it.
    const world = fakeWorld({ graphql: sameVersion, rest: newerVersion });
    const res = await client().getShippingRatesForCountry('US');
    await settle();

    expect(res.rates).toEqual([
      { id: 'price:1:7', title: 'Standard', price: '4.95', currencyCode: 'USD', zoneName: 'Domestic' },
    ]);
    expect(world.slackPosts).toHaveLength(1);
    expect(world.slackPosts[0]).toContain(`answered with version ${RETIRED_ANSWER}`);
  });

  it('still raises it when the mismatched response is an error', async () => {
    // A call that starts failing BECAUSE of the newer version is the worst case.
    const world = fakeWorld({ graphql: newerVersion, status: 400 });
    const res = await client().testConnection();
    await settle();

    expect(res.success).toBe(false);
    expect(res.error).toContain('Shopify API error: 400');
    expect(world.slackPosts).toHaveLength(1);
  });

  it('treats case and stray spaces as the same version', async () => {
    const world = fakeWorld({ graphql: (asked) => ({ get: () => `  ${asked.toUpperCase()} ` }) });
    await client().testConnection();
    watchShopifyApiVersion({ headers: { get: () => 'UNSTABLE ' } }, 'unstable');
    await settle();

    expect(world.slackPosts).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not call it "retired" when the answer is not a NEWER version', async () => {
    const world = fakeWorld({ graphql: sameVersion });
    watchShopifyApiVersion({ headers: versionHeader('2020-01') }, '2026-07');
    await settle();

    expect(world.slackPosts).toHaveLength(1);
    expect(world.slackPosts[0]).toContain('asked Shopify for version 2026-07');
    expect(world.slackPosts[0]).toContain('answered with version 2020-01');
    expect(world.slackPosts[0]).not.toContain('was retired');
    expect(world.slackPosts[0]).toContain('the cause is not known yet');
    expect(world.slackPosts[0]).toContain('~/Summit Soul AI/automation/shopify_api_check/');
  });
});

describe('the watch can never break or delay a Shopify call', () => {
  it('a Slack post that blows up is swallowed', async () => {
    const world = fakeWorld({
      graphql: newerVersion,
      slack: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await client().testConnection()).toEqual({ success: true });
    await settle();

    expect(world.slackPosts).toHaveLength(1);
    // Not delivered, and it says so where the logs are read.
    expect(said(error)).toContain('NOT delivered');
  });

  it('a Slack that refuses the message (200, ok:false) is reported as not delivered', async () => {
    fakeWorld({
      graphql: newerVersion,
      slack: async () => ({ ok: true, status: 200, text: async () => '{"ok":false,"error":"trigger_not_published"}' }),
    });
    expect(await client().testConnection()).toEqual({ success: true });
    await settle();

    expect(said(error)).toContain('NOT delivered');
  });

  it('a Slack that hangs does not hold the Shopify call', async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((r) => (release = r));
    let slackAnswered = false;
    const world = fakeWorld({
      graphql: newerVersion,
      slack: async () => {
        await gate;
        slackAnswered = true;
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
    });

    // Resolves while Slack is still hanging.
    expect(await client().testConnection()).toEqual({ success: true });
    expect(world.slackPosts).toHaveLength(1);
    expect(slackAnswered).toBe(false);

    release(undefined);
    await settle();
    expect(slackAnswered).toBe(true);
  });

  it('a missing webhook is swallowed, and the console still says it', async () => {
    vi.stubEnv('SLACK_ESCALATION_WEBHOOK_URL', '');
    const world = fakeWorld({ graphql: newerVersion });
    expect(await client().testConnection()).toEqual({ success: true });
    await settle();

    expect(world.slackPosts).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(said(error)).toContain('NOT delivered');
  });

  it('a header read that throws is swallowed', async () => {
    const world = fakeWorld({
      graphql: () => ({
        get: () => {
          throw new Error('boom');
        },
      }),
    });
    expect(await client().testConnection()).toEqual({ success: true });
    expect((await client().getShippingRatesForCountry('US')).rates).toHaveLength(1);
    expect(() => watchShopifyApiVersion(null, '2026-07')).not.toThrow();
    expect(() => watchShopifyApiVersion(undefined, '2026-07')).not.toThrow();
    await settle();

    expect(world.slackPosts).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
