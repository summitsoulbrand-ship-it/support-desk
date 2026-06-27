/**
 * Read-only Gmail IMAP reader for Printify support emails.
 *
 * Printify's live-chat / ticket replies are emailed to summitsoulbrand@gmail.com
 * from merchantsupport@printify.com. This reader pulls those messages (and ONLY
 * those) so the recovery reconciler can mine them for refund / reprint / cancel
 * outcomes. It never writes, deletes, or marks anything in the mailbox.
 *
 * Auth is a Gmail App Password over IMAP (same shape as the Zoho provider) - no
 * OAuth. Config via env:
 *   GMAIL_IMAP_USER      e.g. summitsoulbrand@gmail.com
 *   GMAIL_IMAP_PASSWORD  16-char Google app password (NOT the account password)
 *   GMAIL_IMAP_HOST      optional, default imap.gmail.com
 *   GMAIL_IMAP_PORT      optional, default 993
 */

import Imap from 'imap';
import { simpleParser, Source } from 'mailparser';

export const PRINTIFY_SENDER = 'merchantsupport@printify.com';

export interface PrintifyEmail {
  /** RFC822 Message-ID header (stable dedupe key). Falls back to imap-uid:<uid>. */
  messageId: string;
  /** IMAP UID (per-mailbox, monotonic within a uidvalidity) - the watermark. */
  uid: number;
  date: Date;
  subject: string;
  /** Plaintext body (transcript). Falls back to stripped HTML when text is absent. */
  text: string;
}

/** Incremental fetch result: the emails plus the new watermark to persist. */
export interface PrintifyFetchResult {
  emails: PrintifyEmail[];
  /** Highest UID seen this run (carry into the next run). 0 if none. */
  lastUid: number;
  /** Mailbox UIDVALIDITY - if it changes, stored UIDs are stale and we resync. */
  uidValidity: number;
}

export interface GmailReaderConfig {
  user: string;
  password: string;
  host: string;
  port: number;
}

export function gmailConfigFromEnv(): GmailReaderConfig | null {
  const user = process.env.GMAIL_IMAP_USER;
  const password = process.env.GMAIL_IMAP_PASSWORD;
  if (!user || !password) return null;
  return {
    user,
    password,
    host: process.env.GMAIL_IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.GMAIL_IMAP_PORT || '993', 10),
  };
}

function formatImapDate(d: Date): string {
  // IMAP SINCE wants "DD-Mon-YYYY".
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function connect(config: GmailReaderConfig): Promise<Imap> {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: true,
      tlsOptions: { rejectUnauthorized: true, servername: config.host },
      authTimeout: 10000,
      connTimeout: 30000,
    });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

function fetchOne(imap: Imap, uid: number): Promise<PrintifyEmail | null> {
  return new Promise((resolve, reject) => {
    const f = imap.fetch([uid], { bodies: '', struct: false });
    let parse: Promise<PrintifyEmail | null> | null = null;

    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        parse = simpleParser(stream as unknown as Source)
          .then((p) => {
            const text =
              p.text ||
              (p.html ? p.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '');
            return {
              messageId: p.messageId || `imap-uid:${uid}`,
              uid,
              date: p.date || new Date(),
              subject: p.subject || '',
              text,
            };
          })
          .catch((err) => {
            console.error('[printify-recovery] parse error:', err);
            return null;
          });
      });
    });
    f.once('error', reject);
    f.once('end', async () => resolve(parse ? await parse : null));
  });
}

export interface FetchOpts {
  /** Watermark: only fetch messages with UID greater than this. */
  lastUid?: number;
  /** UIDVALIDITY the watermark belongs to; mismatch forces a date-window resync. */
  uidValidity?: number;
  /** Date floor for the first run / after a uidvalidity reset. */
  sinceFallback: Date;
  /** Hard cap on messages fetched per run. */
  maxMessages?: number;
}

/**
 * Incrementally fetch Printify support emails. Normal runs ask the server only
 * for UIDs above the stored watermark (FROM printify + UID lastUid+1:*), so each
 * run downloads ONLY genuinely new messages. On the first run, or if the
 * mailbox's UIDVALIDITY changed (watermark no longer valid), it falls back to a
 * bounded date-window search. Returns the new watermark to persist.
 */
export async function fetchPrintifyEmails(
  config: GmailReaderConfig,
  opts: FetchOpts
): Promise<PrintifyFetchResult> {
  const maxMessages = opts.maxMessages ?? 200;
  const imap = await connect(config);
  try {
    const box = await new Promise<{ uidvalidity: number }>((resolve, reject) => {
      imap.openBox('INBOX', /* readOnly */ true, (err, b) =>
        err ? reject(err) : resolve(b as unknown as { uidvalidity: number })
      );
    });
    const uidValidity = box.uidvalidity;

    // Incremental only when we have a watermark from THIS uidvalidity.
    const canIncrement =
      typeof opts.lastUid === 'number' &&
      opts.lastUid > 0 &&
      opts.uidValidity === uidValidity;

    const criteria: (string | string[])[] = canIncrement
      ? [['FROM', PRINTIFY_SENDER], ['UID', `${opts.lastUid! + 1}:*`]]
      : [['FROM', PRINTIFY_SENDER], ['SINCE', formatImapDate(opts.sinceFallback)]];

    const found = await new Promise<number[]>((resolve, reject) => {
      imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
    });

    // IMAP "lastUid+1:*" always returns at least the highest UID even when none
    // are actually newer, so filter to strictly-greater UIDs.
    const uids = (canIncrement ? found.filter((u) => u > opts.lastUid!) : found)
      .sort((a, b) => a - b)
      .slice(-maxMessages);

    const out: PrintifyEmail[] = [];
    let maxUid = opts.uidValidity === uidValidity ? opts.lastUid ?? 0 : 0;
    for (const uid of uids) {
      try {
        const msg = await fetchOne(imap, uid);
        if (msg) out.push(msg);
        if (uid > maxUid) maxUid = uid;
      } catch (err) {
        console.error(`[printify-recovery] fetch uid ${uid} failed:`, err);
      }
    }
    return { emails: out, lastUid: maxUid, uidValidity };
  } finally {
    try {
      imap.end();
    } catch {
      /* ignore */
    }
  }
}
