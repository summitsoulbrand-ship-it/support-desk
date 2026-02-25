const { PrismaClient } = require('@prisma/client');

async function createAdmin() {
  const prisma = new PrismaClient();
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      // Hash for 'admin123' generated with bcrypt, 12 rounds
      const passwordHash = '$2b$12$G/Q2uLTLjUwMZtFiL5QzxuKcPrh5RpxNOjHBT4KS9jLgh77IRtxF2';

      await prisma.user.create({
        data: {
          email: 'admin@support.local',
          name: 'Admin',
          passwordHash: passwordHash,
          role: 'ADMIN',
        }
      });
      console.log('Created default admin: admin@support.local / admin123');
    } else {
      console.log('Users exist, skipping admin creation');
    }
  } catch (e) {
    console.log('Admin creation skipped:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
