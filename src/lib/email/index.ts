/**
 * Email provider module
 * Provides factory functions for creating email providers
 */

export * from './types';
export { ZohoImapSmtpProvider } from './zoho-imap-provider';

import { EmailProvider, ZohoImapSmtpConfig } from './types';
import { ZohoImapSmtpProvider } from './zoho-imap-provider';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

/**
 * Create an email provider from integration settings
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
