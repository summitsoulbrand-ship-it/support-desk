import { describe, it, expect, vi, afterEach } from 'vitest';
import { postToEodReport } from './slack';

/** Stub fetch with one canned Slack reply. */
function replyWith(status: number, body: string) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('postToEodReport delivery verdict', () => {
  it('is true when the workflow actually ran', async () => {
    vi.stubEnv('SLACK_EOD_WEBHOOK_URL', 'https://hooks.slack.com/triggers/T/1/x');
    replyWith(200, '{"ok":true}');
    expect(await postToEodReport('hi')).toBe(true);
  });

  it('is FALSE when Slack answers 200 but refuses the trigger', async () => {
    // The 2026-08 regression: the plan lapsed, workflows were unpublished, and
    // a 200 was read as delivered - so the email fallback never fired and the
    // reports went nowhere. The refusal lives in the body, not the status.
    vi.stubEnv('SLACK_EOD_WEBHOOK_URL', 'https://hooks.slack.com/triggers/T/1/x');
    replyWith(200, '{"ok":false,"error":"trigger_not_published"}');
    expect(await postToEodReport('hi')).toBe(false);
  });

  it('is true for a classic incoming webhook, which replies with bare "ok"', async () => {
    // /services/... webhooks answer plain text, not JSON. That must not read
    // as a refusal or every one of them starts double-sending by email.
    vi.stubEnv('SLACK_EOD_WEBHOOK_URL', 'https://hooks.slack.com/services/T/B/x');
    replyWith(200, 'ok');
    expect(await postToEodReport('hi')).toBe(true);
  });

  it('is false when the URL no longer exists', async () => {
    vi.stubEnv('SLACK_EOD_WEBHOOK_URL', 'https://hooks.slack.com/triggers/T/1/x');
    replyWith(404, '{"ok":false,"error":"webhook_not_found"}');
    expect(await postToEodReport('hi')).toBe(false);
  });

  it('is false, and posts nothing, when the webhook is not configured', async () => {
    vi.stubEnv('SLACK_EOD_WEBHOOK_URL', '');
    const fetchMock = replyWith(200, '{"ok":true}');
    expect(await postToEodReport('hi')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
