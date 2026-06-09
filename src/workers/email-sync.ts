/**
 * Legacy email sync worker entrypoint
 *
 * The sync implementation now lives in src/lib/email/sync-service.ts (shared
 * with the /api/sync route and src/workers/main.ts). This file remains as a
 * thin wrapper so existing scripts/deployments keep working; prefer running
 * the full worker via `npm run worker` (src/workers/main.ts).
 */

import prisma from '@/lib/db';
import { runEmailSync } from '@/lib/email/sync-service';

// Sync interval in milliseconds (default: 5 minutes)
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '300000', 10);

/**
 * Run email synchronization for all active mailboxes
 */
async function syncEmails() {
  console.log(`[${new Date().toISOString()}] Starting email sync...`);
  const outcome = await runEmailSync();
  if (outcome.skipped) {
    console.log('Sync skipped: another sync is already running');
  } else if (outcome.success) {
    console.log(`Sync completed: ${outcome.messagesProcessed} new messages`);
  } else {
    console.error('Sync failed:', outcome.error);
  }
}

/**
 * Start the sync worker
 */
async function startWorker() {
  console.log('Starting email sync worker...');
  console.log(`Sync interval: ${SYNC_INTERVAL}ms`);

  await syncEmails();
  setInterval(syncEmails, SYNC_INTERVAL);

  console.log('Email sync worker started');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down email sync worker...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down email sync worker...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start worker if run directly
if (require.main === module) {
  startWorker().catch(console.error);
}

export { syncEmails, startWorker };
