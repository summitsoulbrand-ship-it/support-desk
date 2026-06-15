/**
 * Klaviyo profile suppression - honor "STOP" / unsubscribe requests.
 *
 * Suppressing a profile stops it receiving ANY email marketing, regardless of
 * consent state. Uses the GA Bulk Suppress Profiles endpoint. Needs a private
 * API key with profiles:write (or subscriptions:write) scope, read from the
 * KLAVIYO_API_KEY env var.
 */

const KLAVIYO_REVISION = process.env.KLAVIYO_API_REVISION || '2024-10-15';

export interface SuppressResult {
  success: boolean;
  error?: string;
}

export async function suppressKlaviyoProfile(
  email: string
): Promise<SuppressResult> {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error:
        'Klaviyo is not connected. Set KLAVIYO_API_KEY (a private key with profiles:write) to enable unsubscribing.',
    };
  }
  if (!email || !email.includes('@')) {
    return { success: false, error: 'No valid customer email to suppress.' };
  }

  try {
    const res = await fetch(
      'https://a.klaviyo.com/api/profile-suppression-bulk-create-jobs',
      {
        method: 'POST',
        headers: {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: KLAVIYO_REVISION,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          data: {
            type: 'profile-suppression-bulk-create-job',
            attributes: {
              profiles: {
                data: [
                  { type: 'profile', attributes: { email: email.trim() } },
                ],
              },
            },
          },
        }),
      }
    );

    // 202 Accepted (job queued) is the success case; some revisions return 200.
    if (res.status === 202 || res.ok) {
      return { success: true };
    }

    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail =
        body?.errors?.[0]?.detail || body?.errors?.[0]?.title || detail;
    } catch {
      // non-JSON error body
    }
    return { success: false, error: `Klaviyo rejected the request: ${detail}` };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Klaviyo request failed',
    };
  }
}
