/**
 * Email provider module
 * Provides factory functions for creating email providers
 */

export * from './types';
export { ZohoImapSmtpProvider } from './zoho-imap-provider';

import { EmailProvider, ZohoImapSmtpConfig, SendMessageParams, SendResult } from './types';
import { ZohoImapSmtpProvider } from './zoho-imap-provider';
import { ZohoMailApiClient, ZohoMailApiConfig } from '@/lib/zoho-mail-api';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

/**
 * Outbound email sender interface (simpler than full EmailProvider)
 */
export interface OutboundEmailSender {
  sendMessage(params: SendMessageParams): Promise<SendResult>;
  disconnect(): Promise<void>;
}

/**
 * Create an email provider from integration settings
 * This is used for syncing inbound emails (IMAP)
 */
export async function createEmailProvider(): Promise<EmailProvider | null> {
  try {
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'ZOHO_IMAP_SMTP' },
    });

    if (!settings || !settings.enabled) {
      return null;
    }

    const config = decryptJson<ZohoImapSmtpConfig>(settings.encryptedData);
    return new ZohoImapSmtpProvider(config);
  } catch (err) {
    console.error('Failed to create email provider:', err);
    return null;
  }
}

/**
 * Create an outbound email sender
 * Priority: Zoho API > Zoho SMTP
 * Zoho API is preferred since it uses your existing Zoho domain
 */
export async function createOutboundEmailSender(): Promise<OutboundEmailSender | null> {
  try {
    // Check for Zoho Mail API first (preferred - uses existing Zoho domain, no DNS changes)
    const zohoApiSettings = await prisma.integrationSettings.findUnique({
      where: { type: 'ZOHO_API' },
    });

    if (zohoApiSettings?.enabled) {
      const config = decryptJson<ZohoMailApiConfig>(zohoApiSettings.encryptedData);
      const client = new ZohoMailApiClient(config);

      console.log('Using Zoho Mail API for outbound emails');

      return {
        async sendMessage(params: SendMessageParams): Promise<SendResult> {
          const result = await client.sendEmail({
            to: params.to,
            cc: params.cc,
            subject: params.subject,
            bodyHtml: params.bodyHtml,
            bodyText: params.bodyText,
            inReplyTo: params.inReplyTo,
            references: params.references,
            attachments: params.attachments?.map(att => ({
              filename: att.filename,
              content: att.content,
              contentType: att.contentType,
            })),
          });
          return result;
        },
        async disconnect(): Promise<void> {
          // HTTP-based, no connection to close
        },
      };
    }

    // Fall back to Zoho SMTP
    const zohoSettings = await prisma.integrationSettings.findUnique({
      where: { type: 'ZOHO_IMAP_SMTP' },
    });

    if (zohoSettings?.enabled) {
      const config = decryptJson<ZohoImapSmtpConfig>(zohoSettings.encryptedData);
      const provider = new ZohoImapSmtpProvider(config);

      console.log('Using Zoho SMTP for outbound emails');

      return {
        sendMessage: (params) => provider.sendMessage(params),
        disconnect: () => provider.disconnect(),
      };
    }

    return null;
  } catch (err) {
    console.error('Failed to create outbound email sender:', err);
    return null;
  }
}

/**
 * Default Zoho IMAP/SMTP settings
 */
export const ZOHO_DEFAULTS = {
  imapHost: 'imap.zoho.com',
  imapPort: 993,
  imapTls: true,
  smtpHost: 'smtp.zoho.com',
  smtpPort: 465,
  smtpTls: true,
};
