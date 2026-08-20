/**
 * Search the Zoho support mailbox for any message to/from a given address.
 * Used to verify chargeback claims that "the cardholder contacted the merchant".
 *
 *   npx tsx scripts/find-customer-emails.ts 78transplant@gmail.com
 */
import Imap from 'imap';
import { PrismaClient } from '@prisma/client';
import { decryptJson } from '../src/lib/encryption/index';
import { ZohoImapSmtpConfig } from '../src/lib/email/types';

const needle = process.argv[2] || '';
if (!needle) {
  console.error('usage: find-customer-emails.ts <email-or-substring>');
  process.exit(1);
}

async function loadConfig(): Promise<ZohoImapSmtpConfig> {
  const prisma = new PrismaClient();
  const row = await prisma.integrationSettings.findUnique({
    where: { type: 'ZOHO_IMAP_SMTP' as never },
  });
  await prisma.$disconnect();
  if (!row) throw new Error('No ZOHO_IMAP_SMTP integration stored');
  return decryptJson<ZohoImapSmtpConfig>(row.encryptedData);
}

function openBox(imap: Imap, path: string): Promise<void> {
  return new Promise((res, rej) => imap.openBox(path, true, (e) => (e ? rej(e) : res())));
}

function search(imap: Imap, criteria: unknown[]): Promise<number[]> {
  return new Promise((res) =>
    imap.search(criteria as never, (e, uids) => res(e ? [] : uids || []))
  );
}

function listBoxes(imap: Imap): Promise<string[]> {
  return new Promise((res, rej) =>
    imap.getBoxes((e, boxes) => {
      if (e) return rej(e);
      const out: string[] = [];
      const walk = (obj: Imap.MailBoxes, prefix: string) => {
        for (const [name, box] of Object.entries(obj || {})) {
          const path = prefix ? `${prefix}${box.delimiter || '/'}${name}` : name;
          out.push(path);
          if (box.children) walk(box.children, path);
        }
      };
      walk(boxes, '');
      res(out);
    })
  );
}

function fetchHeaders(imap: Imap, uids: number[]): Promise<string[]> {
  return new Promise((res) => {
    if (!uids.length) return res([]);
    const lines: string[] = [];
    const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)' });
    f.on('message', (msg) => {
      let buf = '';
      msg.on('body', (stream) => {
        stream.on('data', (c: Buffer) => (buf += c.toString('utf8')));
      });
      msg.once('end', () => lines.push(buf.replace(/\s*\r?\n\s+/g, ' ').trim()));
    });
    f.once('error', () => res(lines));
    f.once('end', () => res(lines));
  });
}

async function main() {
  const cfg = await loadConfig();
  console.log(`Connecting to ${cfg.imapHost}:${cfg.imapPort} as ${cfg.username}\n`);

  const imap = new Imap({
    user: cfg.username,
    password: cfg.password,
    host: cfg.imapHost,
    port: cfg.imapPort,
    tls: cfg.imapTls !== false,
    tlsOptions: { servername: cfg.imapHost },
    authTimeout: 20000,
  });

  await new Promise<void>((res, rej) => {
    imap.once('ready', () => res());
    imap.once('error', rej);
    imap.connect();
  });

  const boxes = await listBoxes(imap);
  console.log(`Mailboxes: ${boxes.join(', ')}\n`);

  let total = 0;
  for (const path of boxes) {
    try {
      await openBox(imap, path);
    } catch {
      continue;
    }
    const uids = new Set<number>();
    for (const crit of [['FROM', needle], ['TO', needle], ['CC', needle], ['TEXT', needle]]) {
      for (const u of await search(imap, [crit])) uids.add(u);
    }
    if (!uids.size) continue;
    console.log(`### ${path} — ${uids.size} match(es)`);
    for (const h of await fetchHeaders(imap, [...uids])) console.log(h + '\n');
    total += uids.size;
  }

  console.log(`TOTAL MATCHES for "${needle}": ${total}`);
  imap.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
