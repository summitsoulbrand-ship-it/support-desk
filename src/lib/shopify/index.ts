/**
 * Shopify module exports
 */

export * from './types';
export { ShopifyClient } from './client';

import { ShopifyClient } from './client';
import { ShopifyConfig } from './types';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

/**
 * Create a Shopify client from integration settings
 */
export async function createShopifyClient(): Promise<ShopifyClient | null> {
  try {
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'SHOPIFY' },
    });

    if (!settings || !settings.enabled) {
      return null;
    }

    const config = decryptJson<ShopifyConfig>(settings.encryptedData);
    return new ShopifyClient(config);
  } catch (err) {
    console.error('Failed to create Shopify client:', err);
    return null;
  }
}
