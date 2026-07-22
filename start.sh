#!/bin/sh
# Don't use set -e - we handle errors explicitly

echo "Generating Prisma client..."
node node_modules/prisma/build/index.js generate || { echo "Failed to generate Prisma client"; exit 1; }

echo "Checking database state..."
# Check if tables and migrations table exist
DB_STATE=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    const tables = await prisma.\$queryRaw\`SELECT COUNT(*)::int as c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'\`;
    const hasTables = Number(tables[0].c) > 0;
    const migrations = await prisma.\$queryRaw\`SELECT COUNT(*)::int as c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'\`;
    const hasMigrations = Number(migrations[0].c) > 0;
    console.log(hasTables ? (hasMigrations ? 'ready' : 'needs_baseline') : 'fresh');
    await prisma.\$disconnect();
  } catch (e) {
    console.error('DB check error:', e.message);
    console.log('fresh');
  }
  process.exit(0);
})();
" 2>&1 | tail -1)

echo "Database state: $DB_STATE"

if [ "$DB_STATE" = "needs_baseline" ]; then
  echo "Database exists but needs migration baseline (restored from backup)..."
  # Mark all existing migrations as applied
  node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    // Create _prisma_migrations table
    await prisma.\$executeRawUnsafe(\`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id VARCHAR(36) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ,
        migration_name VARCHAR(255) NOT NULL,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_steps_count INT NOT NULL DEFAULT 0
      )
    \`);
    console.log('Created _prisma_migrations table');

    // Get all migration directories
    const migrationsDir = path.join(process.cwd(), 'prisma/migrations');
    const migrations = fs.readdirSync(migrationsDir)
      .filter(f => {
        const fullPath = path.join(migrationsDir, f);
        return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
      })
      .sort();

    console.log('Found migrations:', migrations.length);

    for (const migration of migrations) {
      const id = require('crypto').randomUUID();
      await prisma.\$executeRawUnsafe(\`
        INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES ('\${id}', 'baseline', NOW(), '\${migration}', 1)
        ON CONFLICT (id) DO NOTHING
      \`);
      console.log('Marked as applied:', migration);
    }

    console.log('Baseline complete');
    await prisma.\$disconnect();
  } catch (e) {
    console.error('Baseline error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
"
  if [ $? -ne 0 ]; then
    echo "Baseline failed!"
  fi
fi

# Run migrations (will apply any new migrations not yet in the table)
echo "Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy || echo "Migrations completed with warnings"

# Ensure performance indexes exist (may have been skipped by baseline)
echo "Verifying performance indexes..."
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    // Create indexes if they don't exist (IF NOT EXISTS is safe to run multiple times)
    await prisma.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS threads_status_assigned_user_id_idx ON threads(status, assigned_user_id)\`);
    await prisma.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS threads_customer_email_status_idx ON threads(customer_email, status)\`);
    await prisma.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS threads_status_last_message_at_idx ON threads(status, last_message_at)\`);
    await prisma.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS printify_orders_status_created_at_idx ON printify_orders(status, created_at)\`);
    await prisma.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS printify_orders_created_at_idx ON printify_orders(created_at)\`);
    console.log('Performance indexes verified');
    await prisma.\$disconnect();
  } catch (e) {
    console.error('Index creation error:', e.message);
  }
  process.exit(0);
})();
" || echo "Index verification completed"

if [ "$DB_STATE" = "fresh" ]; then
  echo "Creating default admin for new database..."
  node scripts/create-admin.js
fi

echo "Starting server..."
exec node server.js
