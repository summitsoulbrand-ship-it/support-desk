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
    const [zohoApiSettings, zohoSmtpSettings] = await Promise.all([
      prisma.integrationSettings.findUnique({ where: { type: 'ZOHO_API' } }),
      prisma.integrationSettings.findUnique({ where: { type: 'ZOHO_IMAP_SMTP' } }),
    ]);

    // Zoho SMTP provider (app-password auth - does NOT depend on the Zoho API
    // OAuth refresh token). Built up front so it can serve as a fallback when
    // the Zoho API token is revoked/expired.
    let smtpProvider: ZohoImapSmtpProvider | null = null;
    if (zohoSmtpSettings?.enabled) {
      try {
        smtpProvider = new ZohoImapSmtpProvider(
          decryptJson<ZohoImapSmtpConfig>(zohoSmtpSettings.encryptedData)
        );
      } catch (err) {
        console.error('Failed to build Zoho SMTP fallback provider:', err);
      }
    }

    // Prefer the Zoho Mail API (uses the existing Zoho domain, no DNS changes),
    // but fall back to SMTP if an API send fails (e.g. the OAuth refresh token
    // was revoked -> "Failed to refresh token: Access Denied").
    if (zohoApiSettings?.enabled) {
      const config = decryptJson<ZohoMailApiConfig>(zohoApiSettings.encryptedData);
      const client = new ZohoMailApiClient(config);

      console.log('Using Zoho Mail API for outbound emails');

      return {
        async sendMessage(params: SendMessageParams): Promise<SendResult> {
          try {
            const result = await client.sendEmail({
              to: params.to,
              cc: params.cc,
              fromName: params.fromName,
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
            if (result.success || !smtpProvider) return result;
            console.warn(
              `Zoho API send failed (${result.error}) - falling back to Zoho SMTP`
            );
            return await smtpProvider.sendMessage(params);
          } catch (err) {
            if (!smtpProvider) throw err;
            console.warn(
              `Zoho API send threw (${err instanceof Error ? err.message : err}) - falling back to Zoho SMTP`
            );
            return await smtpProvider.sendMessage(params);
          }
        },
        async disconnect(): Promise<void> {
          // HTTP-based; only the SMTP fallback (if used) holds a connection.
          if (smtpProvider) await smtpProvider.disconnect().catch(() => undefined);
        },
      };
    }

    // No Zoho API configured - use SMTP directly.
    if (smtpProvider) {
      console.log('Using Zoho SMTP for outbound emails');
      return {
        sendMessage: (params) => smtpProvider!.sendMessage(params),
        disconnect: () => smtpProvider!.disconnect(),
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
