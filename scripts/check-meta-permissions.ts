/**
 * Script to check Meta API permissions
 * Run with: npx tsx scripts/check-meta-permissions.ts
 */

import prisma from '../src/lib/db';
import { decryptJson } from '../src/lib/encryption';
import { MetaClient } from '../src/lib/social/meta-client';

async function main() {
  console.log('Checking Meta API permissions...\n');

  // Get Meta integration settings
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'META' },
  });

  if (!settings?.enabled || !settings.encryptedData) {
    console.error('Meta integration is not configured or disabled');
    process.exit(1);
  }

  const config = decryptJson<{
    accessToken: string;
    appId?: string;
    appSecret?: string;
    pages: Array<{
      id: string;
      accessToken: string;
    }>;
  }>(settings.encryptedData);

  if (!config?.accessToken) {
    console.error('No access token found in Meta settings');
    process.exit(1);
  }

  console.log('User Access Token found:', config.accessToken.substring(0, 20) + '...');
  console.log('Pages configured:', config.pages?.length || 0);
  console.log('');

  // Create a client with just the user token
  const userClient = new MetaClient({ accessToken: config.accessToken });

  // Check user token permissions
  console.log('=== USER TOKEN PERMISSIONS ===');
  try {
    const permissions = await userClient.debugTokenPermissions();
    console.log('Granted permissions:');
    permissions.permissions.forEach(p => console.log('  ✓', p));

    // Check for critical permissions
    const critical = ['pages_read_user_content', 'pages_read_engagement', 'pages_manage_engagement'];
    const missing = critical.filter(p => !permissions.permissions.includes(p));

    if (missing.length > 0) {
      console.log('\n⚠️  MISSING CRITICAL PERMISSIONS:');
      missing.forEach(p => console.log('  ✗', p));
      console.log('\nThe "from" field on comments requires "pages_read_user_content" permission.');
      console.log('You need to:');
      console.log('  1. Go to Facebook Developer Console: https://developers.facebook.com/');
      console.log('  2. Select your app');
      console.log('  3. Go to "Use Cases" > "Customize" and add "pages_read_user_content"');
      console.log('  4. If your app is in Live mode, you need to submit for App Review');
    } else {
      console.log('\n✓ All critical permissions are granted');
    }
  } catch (err) {
    console.error('Error checking user permissions:', err);
  }

  console.log('\n=== CHECKING PAGE TOKENS ===');
  for (const page of config.pages || []) {
    console.log(`\nPage ID: ${page.id}`);
    console.log('Page Token:', page.accessToken?.substring(0, 20) + '...');

    // Create client with page token
    const pageClient = new MetaClient({
      accessToken: config.accessToken,
      pageAccessToken: page.accessToken,
      pageId: page.id,
    });

    try {
      // Try to get page info
      const pageInfo = await pageClient.debugPageTokenInfo();
      console.log('Page token valid:', pageInfo.valid);
      if (pageInfo.scopes) {
        console.log('Page scopes:', pageInfo.scopes);
      }
    } catch (err) {
      console.error('Error checking page token:', err);
    }
  }

  // Test a real comment fetch
  console.log('\n=== TESTING COMMENT FETCH ===');
  const account = await prisma.socialAccount.findFirst({
    where: { platform: 'FACEBOOK', enabled: true },
  });

  if (account) {
    console.log('Testing with account:', account.name);

    // Test both a POST and an AD to see if behavior differs
    const adObject = await prisma.socialObject.findFirst({
      where: { externalId: '441715749035841_122142073802683944' }, // AD with comments
    });

    const postObject = await prisma.socialObject.findFirst({
      where: { externalId: '441715749035841_122168517650683944' }, // Regular POST
    });

    const recentObject = adObject; // Start with AD

    if (recentObject) {
      console.log('Testing with object:', recentObject.externalId);

      // Get the page config
      const page = config.pages?.find(p => p.id === account.externalId);
      if (page) {
        const client = new MetaClient({
          accessToken: config.accessToken,
          pageAccessToken: page.accessToken,
          pageId: page.id,
        });

        try {
          const comments = await client.getPostComments(recentObject.externalId, 5);
          console.log('\nFetched', comments.data.length, 'comments');

          if (comments.data.length > 0) {
            console.log('\nSample comment data:');
            const sample = comments.data[0];
            console.log('  Comment ID:', sample.id);
            console.log('  Has "from" field:', !!sample.from);
            console.log('  Raw sample:', JSON.stringify(sample, null, 2));
            if (sample.from) {
              console.log('  From ID:', sample.from.id);
              console.log('  From Name:', sample.from.name);
            } else {
              console.log('\n⚠️  The "from" field is NOT being returned by Meta API');
            }
          }

          // Also try a direct fetch to see the raw response
          console.log('\n=== DIRECT API TEST ===');
          const response = await fetch(
            `https://graph.facebook.com/v21.0/${recentObject.externalId}/comments?` +
            `fields=id,message,from&limit=3&access_token=${page.accessToken}`
          );
          const raw = await response.json();
          console.log('Direct API response:');
          console.log(JSON.stringify(raw, null, 2));

          // Check app mode
          console.log('\n=== CHECKING APP MODE ===');
          const appInfoResponse = await fetch(
            `https://graph.facebook.com/v21.0/app?access_token=${page.accessToken}`
          );
          const appInfo = await appInfoResponse.json();
          console.log('App info:', JSON.stringify(appInfo, null, 2));

          // Also test regular POST
          if (postObject) {
            console.log('\n=== TESTING REGULAR POST (not AD) ===');
            console.log('Post ID:', postObject.externalId);
            const postResponse = await fetch(
              `https://graph.facebook.com/v21.0/${postObject.externalId}/comments?` +
              `fields=id,message,from&limit=3&access_token=${page.accessToken}`
            );
            const postRaw = await postResponse.json();
            console.log('Regular Post comments response:');
            console.log(JSON.stringify(postRaw, null, 2));
          }

        } catch (err) {
          console.error('Error fetching comments:', err);
        }
      }
    }
  }

  console.log('\n=== RECOMMENDATIONS ===');
  console.log('To fix the "Unknown" author issue:');
  console.log('1. Verify your app has "pages_read_user_content" permission');
  console.log('2. If your app is in Development mode, it may work for test users only');
  console.log('3. For production, submit your app for App Review with this permission');
  console.log('4. Re-authenticate the Facebook page after permissions are approved');
  console.log('\nFacebook Developer Console: https://developers.facebook.com/apps/');

  await prisma.$disconnect();
}

main().catch(console.error);
