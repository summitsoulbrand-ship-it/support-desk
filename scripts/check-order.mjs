import { PrismaClient } from '@prisma/client';
import { ShopifyClient } from '../src/lib/shopify/client.js';

const prisma = new PrismaClient();

async function main() {
  // Get Shopify settings
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'SHOPIFY' },
  });
  
  if (!settings || !settings.settings) {
    console.log('Shopify not configured');
    return;
  }
  
  const config = settings.settings;
  const client = new ShopifyClient({
    storeDomain: config.storeDomain,
    accessToken: config.accessToken,
  });
  
  // Look up order #1827
  console.log('Looking up Shopify order #1827...\n');
  const order = await client.getOrderByNumber('1827');
  
  if (order) {
    console.log('=== Shopify Order #1827 ===');
    console.log('Order Name:', order.name);
    console.log('Legacy ID:', order.legacyResourceId);
    console.log('Financial Status:', order.financialStatus);
    console.log('Fulfillment Status:', order.fulfillmentStatus);
    console.log('Total Price:', order.totalPrice, order.totalPriceCurrency);
    console.log('Cancelled At:', order.cancelledAt);
    console.log('Cancel Reason:', order.cancelReason);
    console.log('Tags:', order.tags);
    console.log('');
    console.log('Line Items:');
    for (const li of order.lineItems) {
      console.log('  -', li.quantity, 'x', li.title, li.variantTitle || '');
    }
    console.log('');
    console.log('Metafields (Printify link):');
    for (const mf of order.metafields || []) {
      console.log('  -', mf.namespace + '.' + mf.key, ':', mf.value);
    }
  } else {
    console.log('Order #1827 not found in Shopify');
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
