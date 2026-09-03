/**
 * Slack notifications via incoming webhooks.
 *
 * Deliberately tiny: best-effort, never throws, no-op when the env var is
 * unset - Slack is a notification mirror, never a dependency.
 *  - SLACK_ESCALATION_WEBHOOK_URL -> #escalations (things a human must act on)
 *  - SLACK_SELF_SERVICE_WEBHOOK_URL -> the self-service monitor channel
 *    (EVERY customer portal action, success or failure, for launch oversight)
 *  - SLACK_DESIGN_IDEAS_WEBHOOK_URL -> the design-ideas channel (customer
 *    design suggestions pulled out of support threads, for Pati to review)
 *  - SLACK_EOD_WEBHOOK_URL -> the end-of-day reports channel (VA daily wrap-up)
 *  - SLACK_UPSELL_WEBHOOK_URL -> the upsells channel (post-purchase upsell
 *    merges, and anything that went wrong with one)
 */

/**
 * True only on a CONFIRMED delivery, because every caller uses the answer to
 * decide whether to fall back to email.
 *
 * A 2xx is not enough on its own. These URLs are Workflow Builder triggers
 * (hooks.slack.com/triggers/...), and a trigger whose workflow is unpublished
 * can still answer 200 while quietly doing nothing - which is how the 2026-08
 * plan lapse swallowed reports without a single fallback email firing. Slack
 * puts the real verdict in the body as {"ok": false, "error": "..."}, so read
 * it. Classic incoming webhooks (/services/...) reply with the bare text "ok",
 * which is not JSON and correctly falls through as success.
 */
async function postWebhook(url: string | undefined, text: string): Promise<boolean> {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      console.warn('[slack] webhook post failed:', res.status, slackError(body));
      return false;
    }
    // 200 but Slack refused it: an unpublished or disabled workflow.
    const refusal = slackError(body);
    if (refusal) {
      console.warn('[slack] webhook accepted but refused:', refusal);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[slack] webhook post failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * The error code from a Slack JSON reply that says ok:false, or null when the
 * body is not a refusal (plain "ok", empty, or any non-JSON payload).
 */
function slackError(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown };
    if (parsed.ok === false) {
      return typeof parsed.error === 'string' ? parsed.error : 'refused';
    }
    return null;
  } catch {
    return null;
  }
}

export async function postToSlack(text: string): Promise<boolean> {
  return postWebhook(process.env.SLACK_ESCALATION_WEBHOOK_URL, text);
}

/** Launch-monitoring feed: every self-service customer action lands here. */
export async function postToSelfServiceMonitor(text: string): Promise<boolean> {
  return postWebhook(process.env.SLACK_SELF_SERVICE_WEBHOOK_URL, text);
}

/** Design-ideas channel: customer design suggestions for Pati to review. */
export async function postToDesignIdeas(text: string): Promise<boolean> {
  return postWebhook(process.env.SLACK_DESIGN_IDEAS_WEBHOOK_URL, text);
}

/**
 * Upsells channel: every post-purchase upsell merge, and every upsell that
 * failed. Falls back to the self-service monitor when the upsell webhook is
 * not configured yet - an upsell that silently notified NOBODY is worse than
 * one that lands in the wrong channel.
 */
export async function postToUpsells(text: string): Promise<boolean> {
  const url = process.env.SLACK_UPSELL_WEBHOOK_URL;
  if (url) return postWebhook(url, text);
  return postWebhook(process.env.SLACK_SELF_SERVICE_WEBHOOK_URL, text);
}

/** End-of-day reports channel: the VA's daily wrap-up (never escalations). */
export async function postToEodReport(text: string): Promise<boolean> {
  return postWebhook(process.env.SLACK_EOD_WEBHOOK_URL, text);
}
