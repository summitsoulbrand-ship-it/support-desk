import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.$queryRaw<any[]>`
    SELECT id, status, data 
    FROM printify_orders 
    WHERE data->>'app_order_id' = '19269685.642'
    LIMIT 1
  `;
  
  if (orders.length > 0) {
    const order = orders[0];
    const data = order.data;
    console.log('=== Order #19269685.642 ===\n');
    console.log('Order Status:', data.status);
    console.log('');
    console.log('Line Items:');
    for (const li of data.line_items || []) {
      console.log('  - Status:', li.status);
      console.log('    Title:', li.metadata?.title);
    }
    console.log('');
    console.log('Full data:');
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log('Order not found');
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
