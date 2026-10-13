import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  EffectiveFeatureGuidelinesView,
  OrgFeatureGuidelinesView,
  ProjectFeatureGuidelinesView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';

const { pim, beam } = SEED.users;
const settings = '/settings/feature-guidelines';
const project = `/projects/${SEED.projectId}/feature-guidelines`;
const effective = `${project}/effective`;
const UNKNOWN = '00000000-0000-4000-8000-0000000000ff';

const DEFAULTS = [
  {
    title: 'Moves conversion',
    description: 'Checkout conversion +2%',
    kind: 'KPI',
    required: true,
  },
  {
    title: 'PDPA compliant',
    description: 'No personal data leaves TH',
    kind: 'CONSTRAINT',
    required: true,
  },
  { title: 'Rollout plan', description: '', kind: 'REQUIRED_SECTION', required: false },
] as const;

describe('Feature Guidelines', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  let asMia: ReturnType<typeof as>;

  /** Pim (Admin) saves DEFAULTS; returns their ids in order. */
  async function saveDefaults(): Promise<[string, string, string]> {
    const res = await asPim<OrgFeatureGuidelinesView>('PUT', settings, { criteria: DEFAULTS });
    expect(res.status).toBe(200);
    const [a, b, c] = res.body.criteria.map((c) => c.id);
    if (!a || !b || !c) throw new Error('expected three default criteria');
    return [a, b, c];
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    // Beam is a PO of the seeded Project's Team, without Admin rights.
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
    // Mia is a plain Member of the Organization, not a PO.
    const mia = await db.user.create({
      data: { email: 'mia@acme.test', name: 'Mia', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: mia.id, role: 'MEMBER' },
    });
    asMia = as(app, mia.id);
  });

  test('only Admins replace the Organization default, in order, keeping ids', async () => {
    const empty = await asPim<OrgFeatureGuidelinesView>('GET', settings);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ organizationId: SEED.organizationId, criteria: [] });

    expect((await asBeam('PUT', settings, { criteria: DEFAULTS })).status).toBe(403);
    expect((await asMia('PUT', settings, { criteria: DEFAULTS })).status).toBe(403);

    const [conversion, pdpa, rollout] = await saveDefaults();
    const saved = await asPim<OrgFeatureGuidelinesView>('GET', settings);
    expect(saved.body.criteria).toEqual([
      { id: conversion, ...DEFAULTS[0] },
      { id: pdpa, ...DEFAULTS[1] },
      { id: rollout, ...DEFAULTS[2] },
    ] as never);

    // Reorder, edit one in place, drop one, add one.
    const next = await asPim<OrgFeatureGuidelinesView>('PUT', settings, {
      criteria: [
        { ...DEFAULTS[2], id: rollout, required: true },
        { title: '  Accessible  ', kind: 'CONSTRAINT', required: false },
        { ...DEFAULTS[0], id: conversion },
      ],
    });
    expect(next.status).toBe(200);
    expect(next.body.criteria.map((c) => [c.id === rollout, c.title, c.required])).toEqual([
      [true, 'Rollout plan', true],
      [false, 'Accessible', false],
      [false, 'Moves conversion', true],
    ]);
    expect(next.body.criteria[2]?.id).toBe(conversion);
    expect(next.body.criteria[1]?.description).toBe('');
    expect(await db.guidelineCriterion.count({ where: { id: pdpa } })).toBe(0);
  });

  test('every member of the Organization reads the default, including what a Project hides', async () => {
    const [conversion, pdpa, rollout] = await saveDefaults();
    // The seeded Project hides PDPA; its POs still read that criterion's text.
    const hide = await asPim('PUT', project, {
      overrides: [{ action: 'DISABLE', overridesId: pdpa }],
    });
    expect(hide.status).toBe(200);

    for (const asMember of [asBeam, asMia]) {
      const res = await asMember<OrgFeatureGuidelinesView>('GET', settings);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        organizationId: SEED.organizationId,
        criteria: [
          { id: conversion, ...DEFAULTS[0] },
          { id: pdpa, ...DEFAULTS[1] },
          { id: rollout, ...DEFAULTS[2] },
        ],
      } as never);
    }

    // Someone outside the Organization reads nothing.
    const outsider = await db.user.create({
      data: { email: 'out@elsewhere.test', name: 'Out', passwordHash: 'x' },
    });
    expect((await as(app, outsider.id)('GET', settings)).status).toBe(403);
  });

  test('a non-Admin gets 403 on PUT and the default stays as it was', async () => {
    const ids = await saveDefaults();
    for (const asMember of [asBeam, asMia]) {
      const res = await asMember('PUT', settings, { criteria: [] });
      expect(res.status).toBe(403);
    }
    const after = await asMia<OrgFeatureGuidelinesView>('GET', settings);
    expect(after.body.criteria.map((c) => c.id)).toEqual(ids);
  });

  test('the default list is validated; unknown ids are 422 and change nothing', async () => {
    const [conversion] = await saveDefaults();
    const bad = [
      { criteria: [{ ...DEFAULTS[0], title: '  ' }] },
      { criteria: [{ ...DEFAULTS[0], title: 'x'.repeat(201) }] },
      { criteria: [{ ...DEFAULTS[0], description: 'x'.repeat(2001) }] },
      { criteria: [{ ...DEFAULTS[0], kind: 'RULE' }] },
      { criteria: Array.from({ length: 51 }, () => DEFAULTS[0]) },
      {},
    ];
    for (const body of bad) expect((await asPim('PUT', settings, body)).status).toBe(400);

    const unknown = await asPim('PUT', settings, { criteria: [{ ...DEFAULTS[0], id: UNKNOWN }] });
    expect(unknown.status).toBe(422);
    const twice = await asPim('PUT', settings, {
      criteria: [
        { ...DEFAULTS[0], id: conversion },
        { ...DEFAULTS[1], id: conversion },
      ],
    });
    expect(twice.status).toBe(422);
    // A Project override's id is not a default criterion.
    const [add] = (
      await asBeam<ProjectFeatureGuidelinesView>('PUT', project, {
        overrides: [{ action: 'ADD', ...DEFAULTS[0] }],
      })
    ).body.overrides;
    const hijack = await asPim('PUT', settings, { criteria: [{ ...DEFAULTS[0], id: add?.id }] });
    expect(hijack.status).toBe(422);

    expect((await asPim<OrgFeatureGuidelinesView>('GET', settings)).body.criteria).toHaveLength(3);
  });

  test('effective = default + additions − disabled, with edits applied, and each origin', async () => {
    const [conversion, pdpa, rollout] = await saveDefaults();
    const put = await asBeam<ProjectFeatureGuidelinesView>('PUT', project, {
      overrides: [
        { action: 'ADD', title: 'Works offline', kind: 'CONSTRAINT', required: true },
        { action: 'DISABLE', overridesId: pdpa },
        {
          action: 'EDIT',
          overridesId: conversion,
          title: 'Moves mobile conversion',
          description: 'Mobile checkout conversion +5%',
          kind: 'KPI',
          required: false,
        },
        { action: 'ADD', title: 'Has a demo', kind: 'REQUIRED_SECTION', required: false },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.overrides.map((o) => o.action)).toEqual(['ADD', 'DISABLE', 'EDIT', 'ADD']);
    expect(put.body.overrides[1]).toEqual({
      id: expect.any(String),
      action: 'DISABLE',
      overridesId: pdpa,
    } as never);
    expect((await asBeam<ProjectFeatureGuidelinesView>('GET', project)).body).toEqual(put.body);

    const res = await asMia<EffectiveFeatureGuidelinesView>('GET', effective);
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(SEED.projectId);
    expect(res.body.criteria.map((c) => [c.origin, c.title, c.required, c.overridesId])).toEqual([
      ['PROJECT_EDIT', 'Moves mobile conversion', false, conversion],
      ['ORGANIZATION', 'Rollout plan', false, null],
      ['PROJECT', 'Works offline', true, null],
      ['PROJECT', 'Has a demo', false, null],
    ]);
    expect(res.body.criteria[1]).toEqual({
      id: rollout,
      origin: 'ORGANIZATION',
      overridesId: null,
      ...DEFAULTS[2],
    } as never);

    // The server-side entry point later workflows call.
    const service = app.get(FeatureGuidelinesService);
    expect(await service.effective(SEED.projectId)).toEqual(res.body.criteria);

    // Another Project of the Organization only sees the default.
    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const otherEffective = await asMia<EffectiveFeatureGuidelinesView>(
      'GET',
      `/projects/${other.id}/feature-guidelines/effective`,
    );
    expect(otherEffective.body.criteria.map((c) => c.origin)).toEqual([
      'ORGANIZATION',
      'ORGANIZATION',
      'ORGANIZATION',
    ]);

    // Changing the default text reaches Projects that did not edit it; removing a
    // default criterion removes the Projects' edits and hides of it.
    await asPim('PUT', settings, {
      criteria: [
        { ...DEFAULTS[1], id: pdpa },
        { ...DEFAULTS[2], id: rollout, title: 'Rollout and rollback plan' },
      ],
    });
    const after = await asMia<EffectiveFeatureGuidelinesView>('GET', effective);
    expect(after.body.criteria.map((c) => [c.origin, c.title])).toEqual([
      ['ORGANIZATION', 'Rollout and rollback plan'],
      ['PROJECT', 'Works offline'],
      ['PROJECT', 'Has a demo'],
    ]);
    const overrides = (await asBeam<ProjectFeatureGuidelinesView>('GET', project)).body.overrides;
    expect(overrides.map((o) => o.action)).toEqual(['ADD', 'DISABLE', 'ADD']);
  });

  test('only Admins and the Project’s POs read and change its overrides; everyone in the Organization reads the effective list', async () => {
    await saveDefaults();
    const body = { overrides: [{ action: 'ADD', title: 'Fast', kind: 'KPI', required: true }] };

    expect((await asMia('GET', project)).status).toBe(403);
    expect((await asMia('PUT', project, body)).status).toBe(403);
    expect((await asPim('PUT', project, body)).status).toBe(200);
    expect((await asBeam('GET', project)).status).toBe(200);
    expect((await asMia('GET', effective)).status).toBe(200);

    // A PO of another Project's Team does not change this Project's overrides.
    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const otherTeam = await db.team.create({ data: { projectId: other.id, name: 'Invest' } });
    const cat = await db.user.create({
      data: { email: 'cat@acme.test', name: 'Cat', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: cat.id, role: 'MEMBER' },
    });
    await db.teamMembership.create({ data: { teamId: otherTeam.id, userId: cat.id, role: 'PO' } });
    const asCat = as(app, cat.id);
    expect((await asCat('PUT', project, body)).status).toBe(403);
    expect((await asCat('PUT', `/projects/${other.id}/feature-guidelines`, body)).status).toBe(200);

    // Outside the Organization: 403; unknown Project: 404.
    const outsider = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    expect((await as(app, outsider.id)('GET', effective)).status).toBe(404);
    expect((await as(app, outsider.id)('GET', settings)).status).toBe(403);
    expect((await asPim('GET', `/projects/${UNKNOWN}/feature-guidelines/effective`)).status).toBe(
      404,
    );
    expect((await asPim('PUT', `/projects/${UNKNOWN}/feature-guidelines`, body)).status).toBe(404);
  });

  test('an override references only a default of the same Organization; a bad PUT keeps the previous overrides', async () => {
    const [conversion, pdpa] = await saveDefaults();
    const kept = await asBeam<ProjectFeatureGuidelinesView>('PUT', project, {
      overrides: [
        { action: 'DISABLE', overridesId: pdpa },
        { action: 'ADD', title: 'Fast', kind: 'KPI', required: true },
      ],
    });
    expect(kept.status).toBe(200);
    const projectAddId = kept.body.overrides[1]?.id;

    // A default criterion of another Organization.
    const acme2 = await db.organization.create({ data: { name: 'Globex' } });
    const foreign = await db.guidelineCriterion.create({
      data: {
        organizationId: acme2.id,
        title: 'Globex only',
        description: '',
        kind: 'KPI',
        required: true,
        position: 0,
      },
    });

    const rejected = [
      [{ action: 'DISABLE', overridesId: foreign.id }],
      [{ action: 'EDIT', overridesId: foreign.id, title: 'x', kind: 'KPI', required: true }],
      [{ action: 'DISABLE', overridesId: UNKNOWN }],
      // A Project addition is not a default criterion.
      [{ action: 'DISABLE', overridesId: projectAddId }],
      // One override per default criterion.
      [
        { action: 'DISABLE', overridesId: conversion },
        { action: 'EDIT', overridesId: conversion, title: 'x', kind: 'KPI', required: true },
      ],
    ];
    for (const overrides of rejected) {
      expect((await asBeam('PUT', project, { overrides })).status).toBe(422);
    }
    expect(
      (
        await asBeam('PUT', project, {
          overrides: [
            { action: 'EDIT', overridesId: conversion, title: '', kind: 'KPI', required: true },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await asBeam('PUT', project, {
          overrides: Array.from({ length: 51 }, () => ({
            action: 'ADD',
            title: 'x',
            kind: 'KPI',
            required: true,
          })),
        })
      ).status,
    ).toBe(400);

    expect((await asBeam<ProjectFeatureGuidelinesView>('GET', project)).body).toEqual(kept.body);

    // Replacing with an empty list clears the overrides; the default is untouched.
    const cleared = await asBeam<ProjectFeatureGuidelinesView>('PUT', project, { overrides: [] });
    expect(cleared.body.overrides).toEqual([]);
    const res = await asMia<EffectiveFeatureGuidelinesView>('GET', effective);
    expect(res.body.criteria.map((c) => c.origin)).toEqual([
      'ORGANIZATION',
      'ORGANIZATION',
      'ORGANIZATION',
    ]);
    expect(
      await db.guidelineCriterion.count({ where: { organizationId: SEED.organizationId } }),
    ).toBe(3);
  });
});
