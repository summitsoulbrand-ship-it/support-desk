/**
 * One-off read-only diagnostic: is the Meta webhook path viable?
 * Checks (1) app-level webhook subscription config, (2) page-level
 * subscribed_apps, (3) DB webhookEnabled flags. Prints no secrets.
 *
 * Run: npx tsx scripts/check-webhook-status.ts
 */

import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

const GRAPH = 'https://graph.facebook.com/v25.0';

async function main() {
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'META' },
  });
  if (!settings?.enabled || !settings.encryptedData) {
    console.log('META integration: not configured');
    return;
  }

  const config = decryptJson<{
    accessToken: string;
    appId?: string;
    appSecret?: string;
    webhookVerifyToken?: string;
    pages: Array<{ id: string; accessToken: string }>;
  }>(settings.encryptedData);

  console.log('--- DB config ---');
  console.log('appId present:', !!config.appId);
  console.log('appSecret present:', !!config.appSecret);
  console.log('webhookVerifyToken present:', !!config.webhookVerifyToken);
  console.log('pages:', config.pages?.map((p) => p.id));

  const accounts = await prisma.socialAccount.findMany({
    select: { name: true, platform: true, externalId: true, enabled: true, webhookEnabled: true },
  });
  console.log('--- DB accounts ---');
  for (const a of accounts) {
    console.log(`${a.platform} ${a.name} (${a.externalId}): enabled=${a.enabled} webhookEnabled=${a.webhookEnabled}`);
  }

  if (config.appId && config.appSecret) {
    const appToken = `${config.appId}|${config.appSecret}`;
    const res = await fetch(`${GRAPH}/${config.appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
    const json = await res.json();
    console.log('--- App webhook subscriptions ---');
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('--- App webhook subscriptions: SKIPPED (no appId/appSecret in config) ---');
  }

  const page = config.pages?.[0];
  if (page?.accessToken) {
    const res = await fetch(`${GRAPH}/${page.id}/subscribed_apps?access_token=${encodeURIComponent(page.accessToken)}`);
    const json = await res.json();
    console.log('--- Page subscribed_apps ---');
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('--- Page subscribed_apps: SKIPPED (no page token) ---');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
