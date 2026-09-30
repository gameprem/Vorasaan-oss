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
  },
} as const;

// Placeholder; real password auth arrives with the MVP.
const DEV_PASSWORD_HASH = 'dev-seed-no-login';

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

  await db.organization.upsert({
    where: { id: SEED.organizationId },
    update: {},
    create: { id: SEED.organizationId, name: 'Acme' },
  });

  for (const user of [pim, beam]) {
    await db.user.upsert({
      where: { id: user.id },
      update: {},
      create: { ...user, passwordHash: DEV_PASSWORD_HASH },
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
