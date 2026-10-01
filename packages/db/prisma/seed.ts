import { createPrismaClient } from '../src/index.ts';
import { SEED_PASSWORD, seed, seedFullTeam } from '../src/seed.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const db = createPrismaClient(url);
try {
  await seed(db);
  const ids = await seedFullTeam(db);
  console.log('Seeded the tracer-bullet world:\n');
  console.log(`  Pim  (PO, Admin)  ${ids.users.pim.email}   id ${ids.users.pim.id}`);
  console.log(`  Beam (Backend)    ${ids.users.beam.email}  id ${ids.users.beam.id}`);
  console.log(`  Mint (PO)         ${ids.users.mint.email}  id ${ids.users.mint.id}`);
  console.log(`  Fern (Designer)   ${ids.users.fern.email}  id ${ids.users.fern.id}`);
  console.log(`  Oak  (Tech Lead)  ${ids.users.oak.email}   id ${ids.users.oak.id}`);
  console.log(`  Password for all: ${SEED_PASSWORD}`);
  console.log(`  Feature "Async checkout":        ${ids.featureId}`);
} finally {
  await db.$disconnect();
}
