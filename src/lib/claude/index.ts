/**
 * Claude module exports
 */

export * from './types';
export { ClaudeService } from './service';

import { ClaudeService } from './service';
import { ClaudeConfig } from './types';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

/**
 * Create a Claude service from integration settings
 */
export async function createClaudeService(): Promise<ClaudeService | null> {
  try {
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'CLAUDE' },
    });

    if (!settings || !settings.enabled) {
      // Fall back to environment variables (no custom prompt support)
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        console.log('Claude: Using environment variable config (no custom prompt)');
        return new ClaudeService({
          apiKey,
          projectId: process.env.ANTHROPIC_PROJECT_ID,
        });
      }
      return null;
    }

    const config = decryptJson<ClaudeConfig>(settings.encryptedData);
    console.log('Claude: Using integration settings, custom prompt length:', config.customPrompt?.length || 0);
    return new ClaudeService(config);
  } catch (err) {
    console.error('Failed to create Claude service:', err);
    return null;
  }
}
