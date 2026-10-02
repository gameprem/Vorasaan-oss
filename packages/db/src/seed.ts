import type { PrismaClient } from './generated/prisma/client.js';

// Fixed ids keep the seed idempotent (every write is an upsert) and give
// developers stable values for `x-vorasaan-user` and the CLI.
export const SEED = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  teamId: '00000000-0000-4000-8000-000000000003',
  featureId: '00000000-0000-4000-8000-000000000004',
  users: {
    pim: { id: '00000000-0000-4000-8000-000000000101', email: 'pim@acme.test', name: 'Pim' },
    beam: { id: '00000000-0000-4000-8000-000000000102', email: 'beam@acme.test', name: 'Beam' },
    // Added by seedFullTeam(), not by seed().
    mint: { id: '00000000-0000-4000-8000-000000000103', email: 'mint@acme.test', name: 'Mint' },
    fern: { id: '00000000-0000-4000-8000-000000000104', email: 'fern@acme.test', name: 'Fern' },
    oak: { id: '00000000-0000-4000-8000-000000000105', email: 'oak@acme.test', name: 'Oak' },
  },
} as const;

/** Every seeded user can sign in with this password (local demos only). */
export const SEED_PASSWORD = 'vorasaan-demo';

export const SEED_SPEC_V1 = `# Async checkout

## Goal
Let customers finish checkout without waiting for the payment provider to confirm.
Today checkout blocks for up to 8 seconds while we call the provider synchronously.

## Users
- **Customer** paying in the Mobile Banking app.
- **Support agent** who needs to see why a payment is still pending.

## User flow
1. Customer taps **Pay**.
2. The app shows the order as **Processing** immediately.
3. When the provider confirms, the order becomes **Paid** and the customer gets a push notification.
4. If the provider rejects, the order becomes **Payment failed** with a retry button.

## Acceptance criteria
- [ ] Tapping **Pay** returns to the order screen in under 1 second.
- [ ] An order is never shown as **Paid** before the provider confirms.
- [ ] A rejected payment can be retried from the order screen.
- [ ] Support can see the provider reference and last status change for every order.

## Out of scope
- Changing payment providers.
- Refund flows.

## Open questions
- How long do we wait for the provider before treating a payment as failed?
- Do we notify by push only, or also by email?
`;

/** Seeds the tracer-bullet world. Safe to run repeatedly. */
export async function seed(db: PrismaClient) {
  const { pim, beam } = SEED.users;
  const passwordHash = await Bun.password.hash(SEED_PASSWORD, { algorithm: 'argon2id' });

  await db.organization.upsert({
    where: { id: SEED.organizationId },
    update: {},
    create: { id: SEED.organizationId, name: 'Acme' },
  });

  for (const user of [pim, beam]) {
    await db.user.upsert({
      where: { id: user.id },
      update: { passwordHash },
      create: { ...user, passwordHash },
    });
    await db.orgMembership.upsert({
      where: { organizationId_userId: { organizationId: SEED.organizationId, userId: user.id } },
      update: {},
      // Pim administers the demo Organization.
      create: {
        organizationId: SEED.organizationId,
        userId: user.id,
        role: user.id === pim.id ? 'ADMIN' : 'MEMBER',
      },
    });
  }

  await db.project.upsert({
    where: { id: SEED.projectId },
    update: {},
    create: {
      id: SEED.projectId,
      organizationId: SEED.organizationId,
      name: 'Mobile Banking',
      jiraKey: 'MB',
    },
  });

  await db.team.upsert({
    where: { id: SEED.teamId },
    update: {},
    create: { id: SEED.teamId, projectId: SEED.projectId, name: 'Checkout' },
  });

  const roles = [
    { userId: pim.id, role: 'PO' },
    { userId: beam.id, role: 'BACKEND' },
  ] as const;

  for (const { userId, role } of roles) {
    await db.teamMembership.upsert({
      where: { teamId_userId_role: { teamId: SEED.teamId, userId, role } },
      update: {},
      create: { teamId: SEED.teamId, userId, role },
    });
  }

  await db.feature.upsert({
    where: { id: SEED.featureId },
    update: {},
    create: {
      id: SEED.featureId,
      teamId: SEED.teamId,
      title: 'Async checkout',
      description: 'Stop blocking checkout on the payment provider.',
      status: 'IN_PROGRESS',
    },
  });

  for (const { userId, role } of roles) {
    await db.roleOwner.upsert({
      where: { featureId_userId_role: { featureId: SEED.featureId, userId, role } },
      update: {},
      create: { featureId: SEED.featureId, userId, role },
    });
  }

  await db.specVersion.upsert({
    where: { featureId_version: { featureId: SEED.featureId, version: 1 } },
    update: {},
    create: {
      featureId: SEED.featureId,
      version: 1,
      markdown: SEED_SPEC_V1,
      source: 'MANUAL',
      summary: 'Initial Spec',
      approvedById: pim.id,
    },
  });

  return SEED;
}

/**
 * Adds the rest of the Checkout Team on top of seed(): a second PO who is also a Role Owner
 * of the Feature (so a request can go to all POs and one of them Claims it), a Designer and a
 * Tech Lead (so every Grilling round has someone to ask). `bun run db:seed` and the end-to-end
 * tests use it; API tests keep the smaller world of seed() alone. Safe to run repeatedly.
 */
export async function seedFullTeam(db: PrismaClient) {
  const { mint, fern, oak } = SEED.users;
  const passwordHash = await Bun.password.hash(SEED_PASSWORD, { algorithm: 'argon2id' });

  const members = [
    { user: mint, role: 'PO' },
    { user: fern, role: 'DESIGNER' },
    { user: oak, role: 'TECH_LEAD' },
  ] as const;

  for (const { user, role } of members) {
    await db.user.upsert({
      where: { id: user.id },
      update: { passwordHash },
      create: { ...user, passwordHash },
    });
    await db.orgMembership.upsert({
      where: { organizationId_userId: { organizationId: SEED.organizationId, userId: user.id } },
      update: {},
      create: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
    });
    await db.teamMembership.upsert({
      where: { teamId_userId_role: { teamId: SEED.teamId, userId: user.id, role } },
      update: {},
      create: { teamId: SEED.teamId, userId: user.id, role },
    });
  }

  await db.roleOwner.upsert({
    where: { featureId_userId_role: { featureId: SEED.featureId, userId: mint.id, role: 'PO' } },
    update: {},
    create: { featureId: SEED.featureId, userId: mint.id, role: 'PO' },
  });

  return SEED;
}
