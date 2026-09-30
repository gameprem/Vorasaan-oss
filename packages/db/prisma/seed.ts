import { createPrismaClient } from '../src/index.ts';
import { SEED_PASSWORD, seed } from '../src/seed.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const db = createPrismaClient(url);
try {
  const ids = await seed(db);
  console.log('Seeded the tracer-bullet world:\n');
  console.log(`  Pim  (PO, Admin)  ${ids.users.pim.email}   id ${ids.users.pim.id}`);
  console.log(`  Beam (Backend)    ${ids.users.beam.email}  id ${ids.users.beam.id}`);
  console.log(`  Password for both: ${SEED_PASSWORD}`);
  console.log(`  Feature "Async checkout":        ${ids.featureId}`);
} finally {
  await db.$disconnect();
}
