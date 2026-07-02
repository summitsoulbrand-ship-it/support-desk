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

/** Per-mailbox incremental watermark (UIDs are only meaningful per mailbox). */
export interface BoxWatermark {
  /** Highest UID seen in this mailbox. 0 if none. */
  lastUid: number;
  /** Mailbox UIDVALIDITY - if it changes, stored UIDs are stale and we resync. */
  uidValidity: number;
}

/** Incremental fetch result: the emails plus the new watermarks to persist. */
export interface PrintifyFetchResult {
  emails: PrintifyEmail[];
  /** Keyed by mailbox role ('all', 'trash'). Carry into the next run. */
  watermarks: Record<string, BoxWatermark>;
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

/**
 * Resolve a Gmail special-use folder (e.g. \All, \Trash) by attribute, falling
 * back to the conventional name. Printify emails are often archived or
 * filtered out of the INBOX, so we search All Mail - and All Mail EXCLUDES
 * Trash, so deleted confirmations must be searched separately in \Trash (the
 * operator routinely deletes Printify emails after reading them).
 */
function resolveSpecialUseBox(
  imap: Imap,
  attrib: string,
  fallback: string
): Promise<string> {
  return new Promise((resolve) => {
    imap.getBoxes((err, boxes) => {
      if (err || !boxes) return resolve(fallback);
      const walk = (
        obj: Record<string, { attribs?: string[]; delimiter?: string; children?: unknown }>,
        prefix = ''
      ): string | null => {
        for (const key of Object.keys(obj)) {
          const box = obj[key];
          const name = prefix + key;
          if ((box.attribs || []).includes(attrib)) return name;
          if (box.children) {
            const found = walk(
              box.children as Record<string, { attribs?: string[]; delimiter?: string; children?: unknown }>,
              name + (box.delimiter || '/')
            );
            if (found) return found;
          }
        }
        return null;
      };
      resolve(walk(boxes as never) || fallback);
    });
  });
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
  /** Per-mailbox watermarks from the previous run (keyed 'all', 'trash'). */
  watermarks?: Record<string, BoxWatermark | undefined>;
  /** Date floor for the first run / after a uidvalidity reset. */
  sinceFallback: Date;
  /** Hard cap on messages fetched per mailbox per run. */
  maxMessages?: number;
}

/** The mailboxes scanned: All Mail (archived/labeled) AND Trash - the operator
 *  deletes Printify emails after reading, and All Mail excludes Trash, so
 *  confirmations would otherwise vanish from the scan. Note Gmail purges
 *  Trash after ~30 days, so the hourly cadence is what keeps this reliable. */
const SCAN_BOXES = [
  { key: 'all', attrib: '\\All', fallback: '[Gmail]/All Mail' },
  { key: 'trash', attrib: '\\Trash', fallback: '[Gmail]/Trash' },
] as const;

/**
 * Incrementally fetch Printify support emails from All Mail + Trash. Normal
 * runs ask the server only for UIDs above each mailbox's stored watermark
 * (FROM printify + UID lastUid+1:*), so each run downloads ONLY genuinely new
 * messages. On the first run, or if a mailbox's UIDVALIDITY changed (watermark
 * no longer valid), that mailbox falls back to a bounded date-window search.
 * Returns the new per-mailbox watermarks to persist.
 */
export async function fetchPrintifyEmails(
  config: GmailReaderConfig,
  opts: FetchOpts
): Promise<PrintifyFetchResult> {
  const maxMessages = opts.maxMessages ?? 200;
  const imap = await connect(config);
  try {
    const out: PrintifyEmail[] = [];
    const watermarks: Record<string, BoxWatermark> = {};
    const seenMessageIds = new Set<string>();

    for (const boxSpec of SCAN_BOXES) {
      let mailbox: string;
      let uidValidity: number;
      try {
        mailbox = await resolveSpecialUseBox(imap, boxSpec.attrib, boxSpec.fallback);
        const box = await new Promise<{ uidvalidity: number }>((resolve, reject) => {
          imap.openBox(mailbox, /* readOnly */ true, (err, b) =>
            err ? reject(err) : resolve(b as unknown as { uidvalidity: number })
          );
        });
        uidValidity = box.uidvalidity;
      } catch (err) {
        // A missing/unopenable box (e.g. no Trash) must not kill the whole run.
        console.error(`[printify-recovery] open ${boxSpec.key} failed:`, err);
        continue;
      }

      const mark = opts.watermarks?.[boxSpec.key];
      // Incremental only when we have a watermark from THIS uidvalidity.
      const canIncrement =
        typeof mark?.lastUid === 'number' &&
        mark.lastUid > 0 &&
        mark.uidValidity === uidValidity;

      const criteria: (string | string[])[] = canIncrement
        ? [['FROM', PRINTIFY_SENDER], ['UID', `${mark!.lastUid + 1}:*`]]
        : [['FROM', PRINTIFY_SENDER], ['SINCE', formatImapDate(opts.sinceFallback)]];

      const found = await new Promise<number[]>((resolve, reject) => {
        imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
      });

      // IMAP "lastUid+1:*" always returns at least the highest UID even when
      // none are actually newer, so filter to strictly-greater UIDs.
      const uids = (canIncrement ? found.filter((u) => u > mark!.lastUid) : found)
        .sort((a, b) => a - b)
        .slice(-maxMessages);

      let maxUid = mark?.uidValidity === uidValidity ? mark?.lastUid ?? 0 : 0;
      for (const uid of uids) {
        try {
          const msg = await fetchOne(imap, uid);
          // A message moved from All Mail to Trash between runs would appear
          // in both scans - dedupe by Message-ID within the run (the DB-level
          // dedup catches cross-run repeats).
          if (msg && !seenMessageIds.has(msg.messageId)) {
            seenMessageIds.add(msg.messageId);
            out.push(msg);
          }
          if (uid > maxUid) maxUid = uid;
        } catch (err) {
          console.error(`[printify-recovery] fetch uid ${uid} failed:`, err);
        }
      }
      watermarks[boxSpec.key] = { lastUid: maxUid, uidValidity };
    }

    return { emails: out, watermarks };
  } finally {
    try {
      imap.end();
    } catch {
      /* ignore */
    }
  }
}
