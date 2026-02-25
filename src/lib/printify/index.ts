/**
 * Printify module exports
 */

export * from './types';
export { PrintifyClient } from './client';

import { PrintifyClient } from './client';
import { PrintifyConfig } from './types';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

/**
 * Create a Printify client from integration settings
 */
export async function createPrintifyClient(): Promise<PrintifyClient | null> {
  try {
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'PRINTIFY' },
    });

    if (!settings || !settings.enabled) {
      return null;
    }

    const config = decryptJson<PrintifyConfig>(settings.encryptedData);
    return new PrintifyClient(config);
  } catch (err) {
    console.error('Failed to create Printify client:', err);
    return null;
  }
}
