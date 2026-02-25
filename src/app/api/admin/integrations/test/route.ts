/**
 * Test integration connection API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';
import { IntegrationType } from '@prisma/client';
import { ZohoImapSmtpProvider, ZohoImapSmtpConfig } from '@/lib/email';
import { ShopifyClient, ShopifyConfig } from '@/lib/shopify';
import { PrintifyClient, PrintifyConfig } from '@/lib/printify';
import { ClaudeService, ClaudeConfig } from '@/lib/claude';
import { JudgemeClient, JudgemeConfig } from '@/lib/judgeme';
import { TrackingMoreClient, TrackingMoreConfig } from '@/lib/trackingmore';
import { z } from 'zod';

const testSchema = z.object({
  type: z.nativeEnum(IntegrationType),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { type } = testSchema.parse(body);

    // Get integration settings
    const integration = await prisma.integrationSettings.findUnique({
      where: { type },
    });

    if (!integration) {
      return NextResponse.json(
        { error: 'Integration not configured' },
        { status: 404 }
      );
    }

    let result: { success: boolean; error?: string };

    switch (type) {
      case 'ZOHO_IMAP_SMTP': {
        const config = decryptJson<ZohoImapSmtpConfig>(integration.encryptedData);
        const provider = new ZohoImapSmtpProvider(config);
        result = await provider.testConnection();
        await provider.disconnect();
        break;
      }
      case 'SHOPIFY': {
        const config = decryptJson<ShopifyConfig>(integration.encryptedData);
        const client = new ShopifyClient(config);
        result = await client.testConnection();
        break;
      }
      case 'PRINTIFY': {
        const config = decryptJson<PrintifyConfig>(integration.encryptedData);
        const client = new PrintifyClient(config);
        result = await client.testConnection();
        break;
      }
      case 'CLAUDE': {
        const config = decryptJson<ClaudeConfig>(integration.encryptedData);
        const service = new ClaudeService(config);
        result = await service.testConnection();
        break;
      }
      case 'SMARTYSTREETS': {
        const config = decryptJson<{ authId: string; authToken: string }>(integration.encryptedData);
        // Test by making a simple autocomplete request
        const params = new URLSearchParams({
          'auth-id': config.authId,
          'auth-token': config.authToken,
          search: '1600 Pennsylvania',
          max_results: '1',
        });
        const response = await fetch(
          `https://us-autocomplete-pro.api.smartystreets.com/lookup?${params}`
        );
        if (response.ok) {
          result = { success: true };
        } else {
          const text = await response.text();
          result = { success: false, error: `API error: ${response.status} - ${text}` };
        }
        break;
      }
      case 'META': {
        const config = decryptJson<{ appId?: string; appSecret?: string; redirectUri?: string }>(integration.encryptedData);
        // For META, we just verify the credentials are present
        // Full OAuth test requires user interaction
        if (config.appId && config.appSecret && config.redirectUri) {
          result = { success: true };
        } else {
          result = { success: false, error: 'Missing App ID, App Secret, or Redirect URI' };
        }
        break;
      }
      case 'JUDGEME': {
        const config = decryptJson<JudgemeConfig>(integration.encryptedData);
        const client = new JudgemeClient(config);
        const testResult = await client.testConnection();
        result = { success: testResult.success, error: testResult.success ? undefined : testResult.message };
        break;
      }
      case 'TRACKINGMORE': {
        const config = decryptJson<TrackingMoreConfig>(integration.encryptedData);
        const client = new TrackingMoreClient(config);
        const testResult = await client.testConnection();
        result = { success: testResult.success, error: testResult.success ? undefined : testResult.message };
        break;
      }
      default:
        result = { success: false, error: 'Unknown integration type' };
    }

    // Update test result
    await prisma.integrationSettings.update({
      where: { type },
      data: {
        lastTestedAt: new Date(),
        testResult: result.success ? 'success' : result.error || 'failed',
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('Error testing integration:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
