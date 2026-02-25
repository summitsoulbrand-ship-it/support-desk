/**
 * Email provider module
 * Provides factory functions for creating email providers
 */

export * from './types';
export { ZohoImapSmtpProvider } from './zoho-imap-provider';

import { EmailProvider, ZohoImapSmtpConfig, SendMessageParams, SendResult } from './types';
import { ZohoImapSmtpProvider } from './zoho-imap-provider';
import { ResendClient, ResendConfig } from '@/lib/resend';
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
 * Checks for Resend first (preferred for Railway), falls back to SMTP
 */
export async function createOutboundEmailSender(): Promise<OutboundEmailSender | null> {
  try {
    // Check for Resend first (preferred - works on Railway)
    const resendSettings = await prisma.integrationSettings.findUnique({
      where: { type: 'RESEND' },
    });

    if (resendSettings?.enabled) {
      const config = decryptJson<ResendConfig>(resendSettings.encryptedData);
      const client = new ResendClient(config);

      console.log('Using Resend for outbound emails');

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
          // Resend is HTTP-based, no connection to close
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
