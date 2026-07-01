/**
 * Shared factory for integration API clients
 *
 * Loads the IntegrationSettings row for the given type, decrypts its config,
 * and builds the client - or returns null when the integration is missing or
 * disabled. Prisma and the encryption helpers are imported dynamically so
 * that importing a client module for its types never drags them into the
 * bundle.
 */

import type { IntegrationType } from '@prisma/client';

export async function createIntegrationClient<TConfig, TClient>(
  type: IntegrationType,
  build: (config: TConfig) => TClient
): Promise<TClient | null> {
  const { default: prisma } = await import('@/lib/db');
  const { decryptJson } = await import('@/lib/encryption');

  const settings = await prisma.integrationSettings.findUnique({
    where: { type },
  });

  if (!settings || !settings.enabled) {
    return null;
  }

  const config = decryptJson<TConfig>(settings.encryptedData);
  return build(config);
}
