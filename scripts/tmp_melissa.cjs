const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasources: { db: { url } } });
(async () => {
  const mode = process.argv[2];
  const row = await p.$queryRaw`
    SELECT t.id FROM threads t JOIN thread_triage tr ON tr.thread_id = t.id
    WHERE tr.entities::text LIKE '%24154%' OR t.subject LIKE '%24154%'
    ORDER BY t.last_message_at DESC LIMIT 1`;
  if (!row[0]) { console.log('THREAD NOT FOUND'); return p.$disconnect(); }
  const id = row[0].id;
  if (mode === 'reset') {
    await p.threadTriage.update({ where: { threadId: id }, data: { classifiedMessageId: null } });
    console.log('RESET', id);
  } else {
    const tr = await p.threadTriage.findUnique({ where: { threadId: id } });
    if (tr?.classifiedMessageId) console.log('RECLASSIFIED', tr.intent, JSON.stringify(tr.entities));
    else console.log('pending');
  }
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
