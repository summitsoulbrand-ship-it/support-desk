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
    if (!res.ok) {
      console.warn('[slack] webhook post failed:', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[slack] webhook post failed:', err instanceof Error ? err.message : err);
    return false;
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

/** End-of-day reports channel: the VA's daily wrap-up (never escalations). */
export async function postToEodReport(text: string): Promise<boolean> {
  return postWebhook(process.env.SLACK_EOD_WEBHOOK_URL, text);
}
