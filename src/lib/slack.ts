/**
 * Slack notifications via an incoming webhook (SLACK_ESCALATION_WEBHOOK_URL).
 *
 * Deliberately tiny: best-effort, never throws, no-op when the env var is
 * unset - Slack is a notification mirror, never a dependency. The webhook
 * posts into the #escalations channel of Pati's own workspace.
 */

export async function postToSlack(text: string): Promise<boolean> {
  const url = process.env.SLACK_ESCALATION_WEBHOOK_URL;
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
