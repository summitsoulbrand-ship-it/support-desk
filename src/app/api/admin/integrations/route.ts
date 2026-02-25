/**
 * Admin Integration Settings API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { encryptJson, decryptJson } from '@/lib/encryption';
import { IntegrationType } from '@prisma/client';
import { z } from 'zod';

// Integration config schemas
const zohoImapSmtpSchema = z.object({
  imapHost: z.string().min(1),
  imapPort: z.number().min(1).max(65535),
  imapTls: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().min(1).max(65535),
  smtpTls: z.boolean(),
  username: z.string().email(),
  password: z.string().min(1),
  folder: z.string().optional(),
});

const shopifySchema = z.object({
  storeDomain: z.string().min(1),
  accessToken: z.string().min(1),
});

const printifySchema = z.object({
  apiToken: z.string().min(1),
  shopId: z.string().min(1),
});

const claudeSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
  projectId: z.string().optional(), // Claude project ID for billing/organization
  customPrompt: z.string().optional(), // Custom system prompt to override/extend default
});

const smartyStreetsSchema = z.object({
  authId: z.string().min(1),
  authToken: z.string().min(1),
});

const metaSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  redirectUri: z.string().min(1),
  webhookVerifyToken: z.string().optional(),
  configId: z.string().optional(), // Facebook Login for Business configuration ID
});

const judgemeSchema = z.object({
  apiToken: z.string().min(1),
  shopDomain: z.string().min(1), // e.g., "mystore.myshopify.com"
});

const trackingmoreSchema = z.object({
  apiKey: z.string().min(1),
});

const resendSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
});

const zohoApiSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1),
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
  dataCenter: z.enum(['com', 'eu', 'in', 'com.au', 'jp']).optional(),
});

const updateSchema = z.object({
  type: z.nativeEnum(IntegrationType),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});

const SECRET_MASK = '********';

async function mergeMaskedSecrets(
  type: IntegrationType,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const existing = await prisma.integrationSettings.findUnique({
    where: { type },
  });

  if (!existing) {
    return { ...config };
  }

  let existingConfig: Record<string, unknown> = {};
  try {
    existingConfig = decryptJson(existing.encryptedData);
  } catch {
    return { ...config };
  }

  const secretKeysByType: Record<IntegrationType, string[]> = {
    ZOHO_IMAP_SMTP: ['password'],
    ZOHO_API: ['clientSecret', 'refreshToken'],
    SHOPIFY: ['accessToken'],
    PRINTIFY: ['apiToken'],
    CLAUDE: ['apiKey'],
    SMARTYSTREETS: ['authToken'],
    META: ['appSecret'],
    JUDGEME: ['apiToken'],
    TRACKINGMORE: ['apiKey'],
    RESEND: ['apiKey'],
  };

  const merged = { ...config };
  for (const key of secretKeysByType[type] || []) {
    const hasKey = Object.prototype.hasOwnProperty.call(merged, key);
    const incomingValue = merged[key];
    if (
      !hasKey ||
      incomingValue === SECRET_MASK
    ) {
      const existingValue = existingConfig[key];
      if (typeof existingValue === 'string' && existingValue.length > 0) {
        merged[key] = existingValue;
      }
    }
  }

  return merged;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const integrations = await prisma.integrationSettings.findMany();

    // Decrypt and mask sensitive data
    const result = integrations.map((integration) => {
      let config = {};
      try {
        config = decryptJson(integration.encryptedData);
        // Mask passwords/tokens
        if (typeof config === 'object' && config !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const masked = { ...config } as any;
          if (masked.password) masked.password = '********';
          if (masked.accessToken) masked.accessToken = '********';
          if (masked.apiToken) masked.apiToken = '********';
          if (masked.apiKey) masked.apiKey = '********';
          if (masked.authToken) masked.authToken = '********';
          if (masked.appSecret) masked.appSecret = '********';
          if (masked.clientSecret) masked.clientSecret = '********';
          if (masked.refreshToken) masked.refreshToken = '********';
          config = masked;
        }
      } catch {
        // Ignore decryption errors
      }

      return {
        id: integration.id,
        type: integration.type,
        enabled: integration.enabled,
        config,
        lastTestedAt: integration.lastTestedAt,
        testResult: integration.testResult,
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('Error listing integrations:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

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
    const data = updateSchema.parse(body);
    const mergedConfig = await mergeMaskedSecrets(data.type, data.config);

    // Validate config based on type
    let validatedConfig: unknown;
    switch (data.type) {
      case 'ZOHO_IMAP_SMTP':
        validatedConfig = zohoImapSmtpSchema.parse(mergedConfig);
        break;
      case 'SHOPIFY':
        validatedConfig = shopifySchema.parse(mergedConfig);
        break;
      case 'PRINTIFY':
        validatedConfig = printifySchema.parse(mergedConfig);
        break;
      case 'CLAUDE':
        validatedConfig = claudeSchema.parse(mergedConfig);
        break;
      case 'SMARTYSTREETS':
        validatedConfig = smartyStreetsSchema.parse(mergedConfig);
        break;
      case 'META':
        validatedConfig = metaSchema.parse(mergedConfig);
        break;
      case 'JUDGEME':
        validatedConfig = judgemeSchema.parse(mergedConfig);
        break;
      case 'TRACKINGMORE':
        validatedConfig = trackingmoreSchema.parse(mergedConfig);
        break;
      case 'RESEND':
        validatedConfig = resendSchema.parse(mergedConfig);
        break;
      case 'ZOHO_API': {
        // Check if we need to exchange auth code for refresh token
        const zohoConfig = mergedConfig as Record<string, unknown>;
        if (zohoConfig.authCode && !zohoConfig.refreshToken) {
          // Exchange auth code for refresh token
          const dc = (zohoConfig.dataCenter as string) || 'com';
          const params = new URLSearchParams({
            client_id: zohoConfig.clientId as string,
            client_secret: zohoConfig.clientSecret as string,
            code: zohoConfig.authCode as string,
            grant_type: 'authorization_code',
          });

          const tokenResponse = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });

          const tokenData = await tokenResponse.json();

          if (tokenData.error || !tokenData.refresh_token) {
            return NextResponse.json(
              { error: `Failed to exchange auth code: ${tokenData.error || 'No refresh token returned'}` },
              { status: 400 }
            );
          }

          // Update config with refresh token
          zohoConfig.refreshToken = tokenData.refresh_token;
          delete zohoConfig.authCode; // Remove the auth code
        }

        validatedConfig = zohoApiSchema.parse(zohoConfig);
        break;
      }
      default:
        return NextResponse.json(
          { error: 'Unknown integration type' },
          { status: 400 }
        );
    }

    // Encrypt the config
    const encryptedData = encryptJson(validatedConfig);

    // Upsert integration
    const integration = await prisma.integrationSettings.upsert({
      where: { type: data.type },
      create: {
        type: data.type,
        encryptedData,
        enabled: data.enabled ?? false,
      },
      update: {
        encryptedData,
        enabled: data.enabled,
      },
    });

    return NextResponse.json({
      id: integration.id,
      type: integration.type,
      enabled: integration.enabled,
      lastTestedAt: integration.lastTestedAt,
      testResult: integration.testResult,
    });
  } catch (err) {
    console.error('Error saving integration:', err);
    if (err instanceof z.ZodError) {
      console.error('Zod validation issues:', JSON.stringify(err.issues, null, 2));
      return NextResponse.json(
        { error: 'Invalid configuration', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
