const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasources: { db: { url } } });
(async () => {
  const res = await p.$queryRaw`
    SELECT COUNT(*)::int AS c, MIN(updated_at) AS first, MAX(updated_at) AS last
    FROM late_order_resolutions WHERE updated_at > NOW() - INTERVAL '30 hours'`;
  console.log('late-order resolutions ticked in last 30h:', JSON.stringify(res, (k,v)=>typeof v==='bigint'?Number(v):v));
  const esc = await p.$queryRaw`
    SELECT COUNT(*)::int AS c FROM printify_escalations WHERE updated_at > NOW() - INTERVAL '30 hours'`;
  console.log('escalations touched in last 30h:', JSON.stringify(esc, (k,v)=>typeof v==='bigint'?Number(v):v));
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
