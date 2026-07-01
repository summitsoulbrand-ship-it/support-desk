/**
 * Printify module exports
 */

export * from './types';
export { PrintifyClient } from './client';

import { PrintifyClient } from './client';
import { PrintifyConfig } from './types';
import { createIntegrationClient } from '@/lib/http/integration-client';

/**
 * Create a Printify client from integration settings
 */
export async function createPrintifyClient(): Promise<PrintifyClient | null> {
  try {
    return await createIntegrationClient(
      'PRINTIFY',
      (config: PrintifyConfig) => new PrintifyClient(config)
    );
  } catch (err) {
    console.error('Failed to create Printify client:', err);
    return null;
  }
}
