/**
 * Diagnostic script to check IMAP mailbox state
 * Run with: npx tsx scripts/diagnose-imap.ts
 */

import 'dotenv/config';
import Imap from 'imap';
import prisma from '../src/lib/db';
import { decryptJson } from '../src/lib/encryption';

interface ZohoConfig {
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
}

async function diagnose() {
  console.log('=== IMAP Diagnostic Tool ===\n');

  // Get current mailbox state
  const mailbox = await prisma.mailbox.findFirst({ where: { active: true } });
  if (!mailbox) {
    console.error('No active mailbox found');
    process.exit(1);
  }

  console.log('Current Mailbox State:');
  console.log(`  lastSyncAt: ${mailbox.lastSyncAt}`);
  console.log(`  lastSyncUid: ${mailbox.lastSyncUid}`);
  console.log(`  uidValidity: ${mailbox.uidValidity}`);
  console.log(`  syncError: ${mailbox.syncError || 'none'}`);
  console.log('');

  // Get IMAP config
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'ZOHO_IMAP_SMTP' },
  });

  if (!settings || !settings.enabled) {
    console.error('ZOHO_IMAP_SMTP integration not configured or disabled');
    process.exit(1);
  }

  const config = decryptJson<ZohoConfig>(settings.encryptedData);

  console.log('Connecting to IMAP...');
  console.log(`  Host: ${config.imapHost}:${config.imapPort}`);
  console.log(`  User: ${config.username}`);
  console.log('');

  const imap = new Imap({
    user: config.username,
    password: config.password,
    host: config.imapHost || 'imap.zoho.com',
    port: config.imapPort || 993,
    tls: config.imapTls !== false,
    tlsOptions: { rejectUnauthorized: true },
    authTimeout: 10000,
    connTimeout: 30000,
  });

  return new Promise<void>((resolve, reject) => {
    imap.once('ready', () => {
      console.log('Connected to IMAP server\n');

      imap.openBox('INBOX', true, (err, box) => {
        if (err) {
          console.error('Error opening INBOX:', err);
          imap.end();
          reject(err);
          return;
        }

        console.log('INBOX State:');
        console.log(`  UIDVALIDITY: ${box.uidvalidity}`);
        console.log(`  UIDNEXT: ${box.uidnext}`);
        console.log(`  Total messages: ${box.messages.total}`);
        console.log('');

        // Check UIDVALIDITY
        if (mailbox.uidValidity && mailbox.uidValidity !== box.uidvalidity) {
          console.log('⚠️  UIDVALIDITY CHANGED!');
          console.log(`   Database has: ${mailbox.uidValidity}`);
          console.log(`   Server has: ${box.uidvalidity}`);
          console.log('   This means UIDs have been reset. Full resync needed.');
          console.log('');
        }

        // Search for UIDs > lastSyncUid
        const searchUid = mailbox.lastSyncUid || 0;
        console.log(`Searching for UIDs > ${searchUid}...`);

        imap.search([['UID', `${searchUid + 1}:*`]], (searchErr, uids) => {
          if (searchErr) {
            console.error('Search error:', searchErr);
            imap.end();
            reject(searchErr);
            return;
          }

          const filteredUids = uids?.filter((uid) => uid > searchUid) || [];
          console.log(`Found ${filteredUids.length} messages with UID > ${searchUid}`);

          if (filteredUids.length > 0) {
            console.log(`UIDs: ${filteredUids.slice(0, 20).join(', ')}${filteredUids.length > 20 ? '...' : ''}`);
          }

          // Also search ALL to see total count
          imap.search(['ALL'], (allErr, allUids) => {
            if (!allErr && allUids) {
              console.log(`\nTotal messages in INBOX: ${allUids.length}`);
              if (allUids.length > 0) {
                const minUid = Math.min(...allUids);
                const maxUid = Math.max(...allUids);
                console.log(`UID range: ${minUid} to ${maxUid}`);
              }
            }

            // Search recent messages by date
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split('T')[0].replace(/-/g, '-');

            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const imapDate = `${String(yesterday.getUTCDate()).padStart(2, '0')}-${months[yesterday.getUTCMonth()]}-${yesterday.getUTCFullYear()}`;

            imap.search([['SINCE', imapDate]], (dateErr, dateUids) => {
              if (!dateErr && dateUids) {
                console.log(`\nMessages since ${imapDate}: ${dateUids.length}`);
                if (dateUids.length > 0) {
                  console.log(`UIDs: ${dateUids.slice(-10).join(', ')}${dateUids.length > 10 ? ' (last 10)' : ''}`);
                }
              }

              console.log('\n=== Diagnosis Complete ===');

              if (filteredUids.length === 0 && box.uidnext && box.uidnext > searchUid + 1) {
                console.log('\n⚠️  POTENTIAL ISSUE DETECTED:');
                console.log(`   UIDNEXT (${box.uidnext}) suggests there should be messages with UID > ${searchUid}`);
                console.log('   But search returned no results. This could indicate:');
                console.log('   1. Messages were deleted from server');
                console.log('   2. IMAP server inconsistency');
                console.log('   3. Search criteria issue');
              }

              imap.end();
              resolve();
            });
          });
        });
      });
    });

    imap.once('error', (err: Error) => {
      console.error('IMAP Connection Error:', err.message);
      reject(err);
    });

    imap.connect();
  });
}

diagnose()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
  });
