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
  date: Date;
  subject: string;
  /** Plaintext body (transcript). Falls back to stripped HTML when text is absent. */
  text: string;
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

/**
 * Fetch Printify support emails received since `since`. Returns newest-first is
 * not guaranteed; callers sort if needed. Caps the number of messages fetched.
 */
export async function fetchPrintifyEmails(
  config: GmailReaderConfig,
  since: Date,
  maxMessages = 200
): Promise<PrintifyEmail[]> {
  const imap = await connect(config);
  try {
    await new Promise<void>((resolve, reject) => {
      imap.openBox('INBOX', /* readOnly */ true, (err) => (err ? reject(err) : resolve()));
    });

    const uids = await new Promise<number[]>((resolve, reject) => {
      imap.search(
        [['FROM', PRINTIFY_SENDER], ['SINCE', formatImapDate(since)]],
        (err, results) => (err ? reject(err) : resolve(results || []))
      );
    });

    // Newest UIDs last in Gmail; take the most recent `maxMessages`.
    const slice = uids.slice(-maxMessages);
    const out: PrintifyEmail[] = [];
    for (const uid of slice) {
      try {
        const msg = await fetchOne(imap, uid);
        if (msg) out.push(msg);
      } catch (err) {
        console.error(`[printify-recovery] fetch uid ${uid} failed:`, err);
      }
    }
    return out;
  } finally {
    try {
      imap.end();
    } catch {
      /* ignore */
    }
  }
}
