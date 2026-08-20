/**
 * Dump full message bodies to/from a given address, oldest first.
 *
 *   npx tsx scripts/dump-customer-thread.ts 78transplant@gmail.com
 */
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';
import { decryptJson } from '../src/lib/encryption/index';
import { ZohoImapSmtpConfig } from '../src/lib/email/types';

const needle = process.argv[2] || '';
if (!needle) {
  console.error('usage: dump-customer-thread.ts <email>');
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

const openBox = (imap: Imap, p: string) =>
  new Promise<void>((res, rej) => imap.openBox(p, true, (e) => (e ? rej(e) : res())));

const search = (imap: Imap, crit: unknown[]) =>
  new Promise<number[]>((res) => imap.search(crit as never, (e, u) => res(e ? [] : u || [])));

type Item = { date: Date; from: string; to: string; subject: string; text: string; box: string };

function fetchFull(imap: Imap, uids: number[], box: string): Promise<Item[]> {
  return new Promise((res) => {
    if (!uids.length) return res([]);
    const out: Item[] = [];
    let pending = 0;
    let ended = false;
    const done = () => {
      if (ended && pending === 0) res(out);
    };
    const f = imap.fetch(uids, { bodies: '' });
    f.on('message', (msg) => {
      pending++;
      const chunks: Buffer[] = [];
      msg.on('body', (stream) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
      });
      msg.once('end', () => {
        simpleParser(Buffer.concat(chunks))
          .then((p) => {
            out.push({
              date: p.date || new Date(0),
              from: p.from?.text || '',
              to: Array.isArray(p.to) ? p.to.map((a) => a.text).join(', ') : p.to?.text || '',
              subject: p.subject || '',
              text: (p.text || '').trim(),
              box,
            });
          })
          .catch(() => {})
          .finally(() => {
            pending--;
            done();
          });
      });
    });
    f.once('error', () => {
      ended = true;
      done();
    });
    f.once('end', () => {
      ended = true;
      done();
    });
  });
}

async function main() {
  const cfg = await loadConfig();
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

  const all: Item[] = [];
  for (const box of ['INBOX', 'Sent', 'Archive', 'INBOX/closed']) {
    try {
      await openBox(imap, box);
    } catch {
      continue;
    }
    const uids = new Set<number>();
    for (const crit of [['FROM', needle], ['TO', needle], ['CC', needle]]) {
      for (const u of await search(imap, [crit])) uids.add(u);
    }
    all.push(...(await fetchFull(imap, [...uids], box)));
  }

  all.sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const m of all) {
    console.log('='.repeat(78));
    console.log(`[${m.box}] ${m.date.toISOString()}`);
    console.log(`FROM:    ${m.from}`);
    console.log(`TO:      ${m.to}`);
    console.log(`SUBJECT: ${m.subject}`);
    console.log('-'.repeat(78));
    console.log(m.text.slice(0, 4000));
    console.log('');
  }
  console.log(`(${all.length} messages)`);
  imap.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
