/**
 * Database seed script
 * Creates initial admin user
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin user
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin User',
      passwordHash,
      role: 'ADMIN',
    },
  });

  console.log('Created admin user:', admin.email);

  // Create demo agent
  const agentPassword = process.env.AGENT_PASSWORD || 'agent123';
  const agentHash = await bcrypt.hash(agentPassword, 12);

  const agent = await prisma.user.upsert({
    where: { email: 'agent@example.com' },
    update: {},
    create: {
      email: 'agent@example.com',
      name: 'Demo Agent',
      passwordHash: agentHash,
      role: 'AGENT',
    },
  });

  console.log('Created agent user:', agent.email);

  console.log('Seeding complete!');
  console.log('');
  console.log('Default credentials:');
  console.log('  Admin: admin@example.com / admin123');
  console.log('  Agent: agent@example.com / agent123');
  console.log('');
  console.log('Change these passwords immediately in production!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
