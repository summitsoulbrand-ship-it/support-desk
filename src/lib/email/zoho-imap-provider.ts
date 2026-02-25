/**
 * Zoho IMAP/SMTP Email Provider
 * Implements email ingestion via IMAP and sending via SMTP
 */

import Imap from 'imap';
import { simpleParser, ParsedMail, AddressObject, Source } from 'mailparser';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import {
  EmailProvider,
  EmailMessage,
  EmailThread,
  EmailAddress,
  EmailAttachment,
  SyncState,
  SyncResult,
  SendMessageParams,
  SendResult,
  ZohoImapSmtpConfig,
} from './types';

/**
 * Parse mailparser AddressObject to our EmailAddress format
 */
function parseAddresses(
  addressObj: AddressObject | AddressObject[] | undefined
): EmailAddress[] {
  if (!addressObj) return [];

  const addresses = Array.isArray(addressObj) ? addressObj : [addressObj];
  const result: EmailAddress[] = [];

  for (const addr of addresses) {
    if (addr.value) {
      for (const v of addr.value) {
        result.push({
          address: v.address || '',
          name: v.name || undefined,
        });
      }
    }
  }

  return result;
}

/**
 * Normalize email subject for fallback threading
 * Removes Re:, Fwd:, etc. prefixes and normalizes whitespace
 */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd|fw):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Known system sender emails that forward contact form messages
 */
const CONTACT_FORM_SENDERS = [
  'mailer@shopify.com',
  'noreply@shopify.com',
  'no-reply@shopify.com',
];

/**
 * Check if an email is from a contact form based on subject or sender
 */
function isContactFormEmail(subject: string, fromAddress?: string): boolean {
  // Check if sender is a known contact form system
  if (fromAddress && CONTACT_FORM_SENDERS.includes(fromAddress.toLowerCase())) {
    return true;
  }

  // Check subject patterns
  const normalized = subject.toLowerCase();
  return normalized.includes('new customer message') ||
         normalized.includes('contact form') ||
         normalized.includes('website inquiry');
}

/**
 * Extract customer email and name from contact form email body
 * Handles formats like:
 * - "Email: customer@example.com" (same line)
 * - "Email:\ncustomer@example.com" (next line - Shopify format)
 * - "Name: John Doe" or "Name:\nJohn Doe"
 */
function extractContactFormCustomer(body: string): { email?: string; name?: string } | null {
  if (!body) return null;

  const result: { email?: string; name?: string } = {};

  // Try to find email - patterns for both same-line and next-line formats
  const emailPatterns = [
    // "Email:\ncustomer@example.com" (Shopify format - label on one line, value on next)
    /(?:email|e-mail)[\s:]*\n\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    // "Email: customer@example.com" (same line)
    /(?:email|e-mail|from|reply[\s-]?to|contact)[\s:]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    // Fallback: any standalone email in the body
    /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/,
  ];

  for (const pattern of emailPatterns) {
    const emailMatch = body.match(pattern);
    if (emailMatch && emailMatch[1]) {
      // Skip common system/noreply emails
      const email = emailMatch[1].toLowerCase();
      if (!email.includes('noreply') &&
          !email.includes('no-reply') &&
          !email.includes('donotreply') &&
          !email.includes('mailer-daemon') &&
          !CONTACT_FORM_SENDERS.includes(email)) {
        result.email = email; // Store lowercase for consistent matching
        break;
      }
    }
  }

  // Try to find name - patterns for both same-line and next-line formats
  const namePatterns = [
    // "Name:\nJohn Doe" (Shopify format - label on one line, value on next)
    /(?:^|\n)name[\s:]*\n\s*([A-Za-z][A-Za-z\s'-]{1,50}?)(?:\n|$)/im,
    // "Name: John Doe" (same line)
    /(?:name|full[\s-]?name|customer)[\s:]+([A-Za-z][A-Za-z\s'-]{1,50}?)(?:\n|<|$|\s{2,}|email)/i,
  ];

  for (const pattern of namePatterns) {
    const nameMatch = body.match(pattern);
    if (nameMatch && nameMatch[1]) {
      const name = nameMatch[1].trim();
      // Validate it looks like a name (not an email or URL)
      if (name.length >= 2 &&
          name.length <= 60 &&
          !name.includes('@') &&
          !name.includes('http') &&
          !name.includes('.com')) {
        result.name = name;
        break;
      }
    }
  }

  return (result.email || result.name) ? result : null;
}

/**
 * Generate a thread key from message headers
 * Only groups messages that are actual replies (have References/In-Reply-To headers)
 * Each standalone email gets its own thread - merging by customer is handled separately
 */
function generateThreadKey(message: EmailMessage): string {
  // If we have references, use the first one as thread key (this is an actual reply)
  if (message.references && message.references.length > 0) {
    return message.references[0];
  }

  // If replying to another message, use that as thread key
  if (message.inReplyTo) {
    return message.inReplyTo;
  }

  // For contact form emails, extract customer info for reply threading
  if (isContactFormEmail(message.subject, message.from.address)) {
    const body = message.bodyText || message.bodyHtml || '';
    const extracted = extractContactFormCustomer(body);
    if (extracted?.email) {
      // Use customer email + subject so our replies get grouped with the original
      const normalized = normalizeSubject(message.subject);
      return `contact-form:${extracted.email}:${normalized}`;
    }
  }

  // No reply headers: use message ID to make each email its own thread
  // Thread merging based on customer identity is handled in sync/route.ts
  return message.messageId;
}

function formatImapDate(date: Date): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

export class ZohoImapSmtpProvider implements EmailProvider {
  readonly providerType = 'zoho-imap';

  private config: ZohoImapSmtpConfig;
  private imap: Imap | null = null;
  private transporter: nodemailer.Transporter | null = null;

  constructor(config: ZohoImapSmtpConfig) {
    this.config = config;
  }

  /**
   * Get IMAP connection
   */
  private getImapConnection(): Promise<Imap> {
    return new Promise((resolve, reject) => {
      if (this.imap && this.imap.state === 'authenticated') {
        resolve(this.imap);
        return;
      }

      this.imap = new Imap({
        user: this.config.username,
        password: this.config.password,
        host: this.config.imapHost,
        port: this.config.imapPort,
        tls: this.config.imapTls,
        tlsOptions: { rejectUnauthorized: true },
        authTimeout: 10000,
        connTimeout: 30000,
      });

      this.imap.once('ready', () => {
        resolve(this.imap!);
      });

      this.imap.once('error', (err: Error) => {
        reject(err);
      });

      this.imap.connect();
    });
  }

  /**
   * Get SMTP transporter
   */
  private getSmtpTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpTls,
        auth: {
          user: this.config.username,
          pass: this.config.password,
        },
      });
    }
    return this.transporter;
  }

  /**
   * Test connection to both IMAP and SMTP
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // Test IMAP
      const imap = await this.getImapConnection();
      await new Promise<void>((resolve, reject) => {
        imap.openBox(this.config.folder || 'INBOX', true, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Test SMTP
      const transporter = this.getSmtpTransporter();
      await transporter.verify();

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Fetch and parse a single message by UID
   */
  private fetchMessage(imap: Imap, uid: number): Promise<EmailMessage | null> {
    return new Promise((resolve, reject) => {
      const fetch = imap.fetch([uid], {
        bodies: '',
        struct: true,
      });

      let message: EmailMessage | null = null;
      let parsePromise: Promise<EmailMessage | null> | null = null;

      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          parsePromise = simpleParser(stream as unknown as Source)
            .then((parsed) => {
              message = this.parsedMailToMessage(parsed, uid);
              return message;
            })
            .catch((err) => {
              console.error('Error parsing message:', err);
              return null;
            });
        });
      });

      fetch.once('error', reject);
      fetch.once('end', async () => {
        if (parsePromise) {
          await parsePromise;
        }
        resolve(message);
      });
    });
  }

  /**
   * Convert ParsedMail to EmailMessage
   */
  private parsedMailToMessage(
    parsed: ParsedMail,
    uid: number
  ): EmailMessage {
    const from = parseAddresses(parsed.from);
    const to = parseAddresses(parsed.to);
    const cc = parseAddresses(parsed.cc);

    // Parse references header
    let references: string[] = [];
    if (parsed.references) {
      references = Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references];
    }

    // Parse attachments
    const attachments: EmailAttachment[] = (parsed.attachments || []).map(
      (att) => ({
        filename: att.filename || 'attachment',
        mimeType: att.contentType,
        size: att.size,
        contentId: att.contentId || undefined,
        content: att.content || undefined,
      })
    );

    return {
      messageId: parsed.messageId || `local-${uuidv4()}`,
      uid,
      from: from[0] || { address: 'unknown@unknown.com' },
      to,
      cc,
      subject: parsed.subject || '(No Subject)',
      date: parsed.date || new Date(),
      bodyText: parsed.text || undefined,
      bodyHtml: parsed.html || undefined,
      inReplyTo: parsed.inReplyTo || undefined,
      references,
      attachments,
    };
  }

  /**
   * Sync new messages since last sync
   */
  async syncNewMessages(state: SyncState): Promise<SyncResult> {
    try {
      const imap = await this.getImapConnection();

      return new Promise((resolve, reject) => {
        imap.openBox(this.config.folder || 'INBOX', true, async (err, box) => {
          if (err) {
            reject(err);
            return;
          }

          const newSyncState: SyncState = {
            lastSyncAt: new Date(),
            uidValidity: box.uidvalidity,
          };

          // Check if UIDVALIDITY changed (mailbox was recreated)
          if (
            state.uidValidity &&
            state.uidValidity !== box.uidvalidity
          ) {
            // UIDVALIDITY changed - need full resync
            console.log('UIDVALIDITY changed, full resync needed');
          }

          // Build search criteria
          let searchCriteria: (string | string[])[] = ['ALL'];

          if (state.lastSyncUid && state.uidValidity === box.uidvalidity) {
            // Fetch messages with UID greater than last synced
            searchCriteria = [['UID', `${state.lastSyncUid + 1}:*`]];
          } else if (state.lastSyncAt) {
            // Fallback to date-based search
            searchCriteria = [['SINCE', formatImapDate(state.lastSyncAt)]];
          }

          imap.search(searchCriteria, async (searchErr, uids) => {
            if (searchErr) {
              reject(searchErr);
              return;
            }

            if (!uids || uids.length === 0) {
              resolve({
                newMessages: [],
                syncState: newSyncState,
              });
              return;
            }

            // Filter out already-synced UIDs
            const newUids = state.lastSyncUid
              ? uids.filter((uid) => uid > state.lastSyncUid!)
              : uids;

            if (newUids.length === 0) {
              resolve({
                newMessages: [],
                syncState: newSyncState,
              });
              return;
            }

            // Fetch all new messages
            const messages: EmailMessage[] = [];
            let maxUid = state.lastSyncUid || 0;

            const fetchMessages = async () => {
              for (const uid of newUids) {
                try {
                  const msg = await this.fetchMessage(imap, uid);
                  if (msg) {
                    messages.push(msg);
                    maxUid = Math.max(maxUid, uid);
                  }
                } catch (fetchErr) {
                  console.error(`Error fetching UID ${uid}:`, fetchErr);
                }
              }
            };

            await fetchMessages();

            newSyncState.lastSyncUid = maxUid;

            resolve({
              newMessages: messages,
              syncState: newSyncState,
            });
          });
        });
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return {
        newMessages: [],
        syncState: state,
        error,
      };
    }
  }

  /**
   * Get all messages for a specific thread
   * Note: IMAP doesn't natively support threads, so this fetches by references
   */
  async getThreadMessages(threadKey: string): Promise<EmailMessage[]> {
    try {
      const imap = await this.getImapConnection();

      return new Promise((resolve, reject) => {
        imap.openBox(this.config.folder || 'INBOX', true, (err) => {
          if (err) {
            reject(err);
            return;
          }

          // Search by Message-ID or References containing the thread key
          // This is a simplified implementation - production would need more sophisticated threading
          imap.search(
            [['HEADER', 'Message-ID', threadKey]],
            async (searchErr, uids) => {
              if (searchErr) {
                // Try searching in References
                imap.search(
                  [['HEADER', 'References', threadKey]],
                  async (refErr, refUids) => {
                    if (refErr) {
                      resolve([]);
                      return;
                    }

                    const messages: EmailMessage[] = [];
                    for (const uid of refUids || []) {
                      const msg = await this.fetchMessage(imap, uid);
                      if (msg) messages.push(msg);
                    }
                    resolve(messages);
                  }
                );
                return;
              }

              const messages: EmailMessage[] = [];
              for (const uid of uids || []) {
                const msg = await this.fetchMessage(imap, uid);
                if (msg) messages.push(msg);
              }
              resolve(messages);
            }
          );
        });
      });
    } catch {
      return [];
    }
  }

  /**
   * Send an email message via SMTP
   */
  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    try {
      const transporter = this.getSmtpTransporter();

      // Generate a unique Message-ID
      const domain = this.config.username.split('@')[1] || 'support-desk.local';
      const messageId = `<${uuidv4()}@${domain}>`;

      // Build email options
      const mailOptions: nodemailer.SendMailOptions = {
        from: this.config.username,
        to: params.to.map((t) =>
          t.name ? `"${t.name}" <${t.address}>` : t.address
        ),
        cc: params.cc?.map((c) =>
          c.name ? `"${c.name}" <${c.address}>` : c.address
        ),
        subject: params.subject,
        text: params.bodyText,
        html: params.bodyHtml,
        messageId,
        headers: {},
      };

      // Add threading headers if replying
      if (params.inReplyTo) {
        mailOptions.inReplyTo = params.inReplyTo;
      }

      if (params.references && params.references.length > 0) {
        mailOptions.references = params.references.join(' ');
      }

      // Add attachments if provided
      if (params.attachments && params.attachments.length > 0) {
        mailOptions.attachments = params.attachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        }));
      }

      console.log('Sending email via SMTP:', {
        from: this.config.username,
        to: mailOptions.to,
        subject: mailOptions.subject,
        smtpHost: this.config.smtpHost,
        smtpPort: this.config.smtpPort,
      });

      const result = await transporter.sendMail(mailOptions);

      console.log('SMTP send result:', {
        messageId: result.messageId,
        response: result.response,
        accepted: result.accepted,
        rejected: result.rejected,
      });

      return {
        success: true,
        messageId: result.messageId || messageId,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.error('SMTP send error:', error, err);
      return {
        success: false,
        error,
      };
    }
  }

  /**
   * Group messages into threads based on headers
   */
  groupIntoThreads(messages: EmailMessage[]): EmailThread[] {
    const threadMap = new Map<string, EmailMessage[]>();

    // Group messages by thread key
    for (const message of messages) {
      const threadKey = generateThreadKey(message);

      if (!threadMap.has(threadKey)) {
        threadMap.set(threadKey, []);
      }
      threadMap.get(threadKey)!.push(message);
    }

    // Convert to EmailThread objects
    const threads: EmailThread[] = [];

    for (const [threadKey, threadMessages] of threadMap) {
      // Sort messages by date
      threadMessages.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );

      const firstMessage = threadMessages[0];
      const lastMessage = threadMessages[threadMessages.length - 1];

      // Determine customer email (the non-support address)
      const supportEmail = this.config.username.toLowerCase();
      let customerEmail = firstMessage.from.address;
      let customerName = firstMessage.from.name;

      // For contact form emails, extract customer info from the body
      if (isContactFormEmail(firstMessage.subject, firstMessage.from.address)) {
        const body = firstMessage.bodyText || firstMessage.bodyHtml || '';
        const extracted = extractContactFormCustomer(body);
        if (extracted?.email) {
          customerEmail = extracted.email;
          customerName = extracted.name || undefined;
        }
      }
      // If first message is from us, customer is in To
      else if (customerEmail.toLowerCase() === supportEmail) {
        const toRecipient = firstMessage.to.find(
          (t) => t.address.toLowerCase() !== supportEmail
        );
        if (toRecipient) {
          customerEmail = toRecipient.address;
          customerName = toRecipient.name;
        }
      }

      threads.push({
        threadKey,
        subject: firstMessage.subject,
        messages: threadMessages,
        lastMessageAt: lastMessage.date,
        customerEmail,
        customerName,
      });
    }

    // Sort threads by last message date (newest first)
    threads.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime()
    );

    return threads;
  }

  /**
   * Disconnect from IMAP
   */
  async disconnect(): Promise<void> {
    if (this.imap) {
      this.imap.end();
      this.imap = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}
