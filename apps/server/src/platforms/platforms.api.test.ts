import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  FeatureView,
  PlatformRef,
  PlatformsInUse,
  PlatformTemplateView,
  ProjectPlatformsView,
  SpecTemplateView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const TEMPLATE = '/settings/platform-template';
// Every check on, and the Design Doc template chosen from the Team Roles (ticket 0069).
const CHECKS_ON = {
  specSection: true,
  someoneToAsk: true,
  noOpenBlockers: true,
  qaReady: true,
  designTemplate: null,
};
const BUILT_IN = [
  { name: 'Back-End', roles: ['BACKEND'], ...CHECKS_ON },
  { name: 'Front-End', roles: ['FRONTEND'], ...CHECKS_ON },
  { name: 'Mobile', roles: ['MOBILE'], ...CHECKS_ON },
];
const platformsOf = (projectId: string) => `/projects/${projectId}/platforms`;

/** The list as PUT takes it: ids kept, positions implied by the order. */
function asInput(view: ProjectPlatformsView) {
  return view.platforms.map(({ position: _position, ...p }) => p);
}

describe('Platforms per Project, targeted by Features (ticket 0050)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  async function createProject(name: string): Promise<string> {
    const res = await asPim<{ id: string }>('POST', '/projects', { name });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function platforms(projectId: string): Promise<ProjectPlatformsView> {
    const res = await asPim<ProjectPlatformsView>('GET', platformsOf(projectId));
    expect(res.status).toBe(200);
    return res.body;
  }

  async function addFlutter(projectId: string): Promise<ProjectPlatformsView> {
    const current = await platforms(projectId);
    const res = await asPim<ProjectPlatformsView>('PUT', platformsOf(projectId), {
      platforms: [...asInput(current), { name: 'Flutter', roles: ['MOBILE'] }],
    });
    expect(res.status).toBe(200);
    return res.body;
  }

  /** The seeded Project's Platform with that name. */
  async function seededPlatform(name: string): Promise<string> {
    const p = (await platforms(SEED.projectId)).platforms.find((x) => x.name === name);
    if (!p) throw new Error(`No ${name} Platform`);
    return p.id;
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
  });

  test('the Organization default starts as the built-in template; every member reads it, Admins replace it', async () => {
    const builtIn = await asBeam<PlatformTemplateView>('GET', TEMPLATE);
    expect(builtIn.status).toBe(200);
    expect(builtIn.body).toEqual({
      organizationId: SEED.organizationId,
      builtIn: true,
      platforms: BUILT_IN,
    } as never);

    const flutter = { name: 'Flutter', roles: ['MOBILE'] };
    expect((await asBeam('PUT', TEMPLATE, { platforms: [flutter] })).status).toBe(403);

    const saved = await asPim<PlatformTemplateView>('PUT', TEMPLATE, {
      platforms: [...BUILT_IN, { ...flutter, roles: ['MOBILE', 'MOBILE'], qaReady: false }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.builtIn).toBe(false);
    expect(saved.body.platforms.at(-1)).toEqual({
      name: 'Flutter',
      roles: ['MOBILE'],
      ...CHECKS_ON,
      qaReady: false,
    } as never);
    expect((await asBeam<PlatformTemplateView>('GET', TEMPLATE)).body).toEqual(saved.body);

    // Names are unique ignoring case, and the default is never empty.
    const twice = await asPim('PUT', TEMPLATE, { platforms: [flutter, { name: 'flutter' }] });
    expect(twice.status).toBe(400);
    expect((await asPim('PUT', TEMPLATE, { platforms: [] })).status).toBe(400);
    const heading = await asPim('PUT', TEMPLATE, { platforms: [{ name: '## iOS', roles: [] }] });
    expect(heading.status).toBe(400);
  });

  test('a new Project gets the Organization default; adding Flutter to one Project leaves the others unchanged', async () => {
    const payments = await createProject('Payments');
    const paymentsList = await platforms(payments);
    expect(paymentsList.platforms.map(({ id: _id, ...p }) => p)).toEqual(
      BUILT_IN.map((p, position) => ({ ...p, position })) as never,
    );

    await asPim('PUT', TEMPLATE, {
      platforms: [
        { name: 'API', roles: ['BACKEND'] },
        { name: 'Web', roles: ['FRONTEND'] },
      ],
    });
    const lending = await createProject('Lending');
    expect((await platforms(lending)).platforms.map((p) => p.name)).toEqual(['API', 'Web']);
    // Changing the default didn't rewrite the Project created before it.
    expect(await platforms(payments)).toEqual(paymentsList);

    const withFlutter = await addFlutter(payments);
    expect(withFlutter.platforms.map((p) => [p.name, p.position, p.roles])).toEqual([
      ['Back-End', 0, ['BACKEND']],
      ['Front-End', 1, ['FRONTEND']],
      ['Mobile', 2, ['MOBILE']],
      ['Flutter', 3, ['MOBILE']],
    ]);
    expect((await platforms(lending)).platforms.map((p) => p.name)).toEqual(['API', 'Web']);
    expect((await platforms(SEED.projectId)).platforms.map((p) => p.name)).toEqual([
      'Back-End',
      'Front-End',
      'Mobile',
    ]);
  });

  test("everyone reads a Project's Platforms; only Admins and the Project's POs change them", async () => {
    const read = await asBeam<ProjectPlatformsView>('GET', platformsOf(SEED.projectId));
    expect(read.status).toBe(200);
    expect(read.body.canEdit).toBe(false);
    const list = { platforms: [...asInput(read.body), { name: 'Flutter', roles: ['MOBILE'] }] };
    expect((await asBeam('PUT', platformsOf(SEED.projectId), list)).status).toBe(403);

    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
    const asPo = await asBeam<ProjectPlatformsView>('PUT', platformsOf(SEED.projectId), list);
    expect(asPo.status).toBe(200);
    expect(asPo.body.canEdit).toBe(true);
    expect(asPo.body.platforms.map((p) => p.name)).toContain('Flutter');

    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asPim('GET', platformsOf(unknown))).status).toBe(404);
  });

  test('editing in place keeps ids: rename, reorder, swap names and switch checks off', async () => {
    const before = await platforms(SEED.projectId);
    const [backEnd, frontEnd, mobile] = asInput(before);
    if (!backEnd || !frontEnd || !mobile) throw new Error('expected the built-in Platforms');
    await asPim('PUT', `/features/${SEED.featureId}/platforms`, { platformIds: [mobile.id] });

    const res = await asPim<ProjectPlatformsView>('PUT', platformsOf(SEED.projectId), {
      platforms: [
        { ...mobile, name: 'iOS', someoneToAsk: false },
        { ...frontEnd, name: 'Back-End' },
        { ...backEnd, name: 'Front-End' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.platforms.map((p) => [p.id, p.name, p.position, p.someoneToAsk])).toEqual([
      [mobile.id, 'iOS', 0, false],
      [frontEnd.id, 'Back-End', 1, true],
      [backEnd.id, 'Front-End', 2, true],
    ]);
    // The Feature still targets the renamed Platform.
    const feature = await asPim<FeatureView>('GET', `/features/${SEED.featureId}`);
    expect(feature.body.platforms).toEqual([{ id: mobile.id, name: 'iOS' }]);

    const clash = await asPim('PUT', platformsOf(SEED.projectId), {
      platforms: [mobile, { name: 'MOBILE', roles: [] }],
    });
    expect(clash.status).toBe(400);
    const foreign = await asPim('PUT', platformsOf(SEED.projectId), {
      platforms: [{ ...mobile, id: '00000000-0000-4000-8000-0000000000ff' }],
    });
    expect(foreign.status).toBe(422);
  });

  test("a Feature can only target its own Project's Platforms", async () => {
    const backEnd = await seededPlatform('Back-End');
    const mobile = await seededPlatform('Mobile');
    const other = await createProject('Payments');
    const otherBackEnd = (await platforms(other)).platforms[0]?.id;
    const url = `/features/${SEED.featureId}/platforms`;

    const refused = await asPim('PUT', url, { platformIds: [backEnd, otherBackEnd] });
    expect(refused.status).toBe(422);
    expect(await db.featurePlatform.count()).toBe(0);

    // Beam isn't the Team's PO.
    expect((await asBeam('PUT', url, { platformIds: [backEnd] })).status).toBe(403);

    const set = await asPim<PlatformRef[]>('PUT', url, { platformIds: [mobile, backEnd, mobile] });
    expect(set.status).toBe(200);
    // In the Project's order, each once.
    expect(set.body).toEqual([
      { id: backEnd, name: 'Back-End' },
      { id: mobile, name: 'Mobile' },
    ]);
    const feature = await asBeam<FeatureView>('GET', `/features/${SEED.featureId}`);
    expect(feature.body.platforms).toEqual(set.body);

    const cleared = await asPim<PlatformRef[]>('PUT', url, { platformIds: [] });
    expect(cleared.body).toEqual([]);

    // A new Feature can name its targets, also only from its own Project.
    const created = await asPim<{ id: string }>('POST', `/teams/${SEED.teamId}/features`, {
      title: 'Instant transfer',
      platformIds: [mobile],
    });
    expect(created.status).toBe(201);
    const view = await asPim<FeatureView>('GET', `/features/${created.body.id}`);
    expect(view.body.platforms).toEqual([{ id: mobile, name: 'Mobile' }]);
    const wrong = await asPim('POST', `/teams/${SEED.teamId}/features`, {
      title: 'Wrong Platform',
      platformIds: [otherBackEnd],
    });
    expect(wrong.status).toBe(422);
    expect(await db.feature.count({ where: { title: 'Wrong Platform' } })).toBe(0);
  });

  test('removing a Platform that Features target is refused, naming those Features', async () => {
    const view = await addFlutter(SEED.projectId);
    const flutter = view.platforms.find((p) => p.name === 'Flutter');
    const mobile = view.platforms.find((p) => p.name === 'Mobile');
    if (!flutter || !mobile) throw new Error('expected Flutter and Mobile');
    await asPim('PUT', `/features/${SEED.featureId}/platforms`, { platformIds: [flutter.id] });
    const second = await asPim<{ id: string }>('POST', `/teams/${SEED.teamId}/features`, {
      title: 'Card freeze',
      platformIds: [flutter.id, mobile.id],
    });

    const withoutPhones = asInput(view).filter((p) => p.id !== flutter.id && p.id !== mobile.id);
    const refused = await asPim<PlatformsInUse>('PUT', platformsOf(SEED.projectId), {
      platforms: withoutPhones,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Async checkout');
    expect(refused.body.message).toContain('Card freeze');
    expect(
      refused.body.features
        .map((f) => [f.platformName, f.title, f.id])
        .sort((a, b) => `${a}`.localeCompare(`${b}`)),
    ).toEqual([
      ['Flutter', 'Async checkout', SEED.featureId],
      ['Flutter', 'Card freeze', second.body.id],
      ['Mobile', 'Card freeze', second.body.id],
    ]);
    // Nothing changed, not even the Platforms nobody targets.
    expect(await platforms(SEED.projectId)).toEqual(view);

    // Once no Feature targets Mobile, it can go.
    await asPim('PUT', `/features/${second.body.id}/platforms`, { platformIds: [flutter.id] });
    const removed = await asPim<ProjectPlatformsView>('PUT', platformsOf(SEED.projectId), {
      platforms: asInput(view).filter((p) => p.id !== mobile.id),
    });
    expect(removed.status).toBe(200);
    expect(removed.body.platforms.map((p) => [p.name, p.position])).toEqual([
      ['Back-End', 0],
      ['Front-End', 1],
      ['Flutter', 2],
    ]);

    // Deleting the Project still removes its Platforms and every Feature's targets.
    await db.project.delete({ where: { id: SEED.projectId } });
    expect(await db.platform.count()).toBe(0);
    expect(await db.featurePlatform.count()).toBe(0);
  });

  test('the Spec template for a Feature targeting Back-End and Flutter has both sections', async () => {
    const view = await addFlutter(SEED.projectId);
    const id = (name: string) => view.platforms.find((p) => p.name === name)?.id;
    await asPim('PUT', `/features/${SEED.featureId}/platforms`, {
      platformIds: [id('Flutter'), id('Back-End')],
    });

    const res = await asBeam<SpecTemplateView>('GET', `/features/${SEED.featureId}/spec-template`);
    expect(res.status).toBe(200);
    const { markdown } = res.body;
    expect(markdown.startsWith('# Async checkout\n')).toBe(true);
    expect(markdown).toContain('## Back-End\n\n### Acceptance criteria\n\n## Flutter\n');
    expect(markdown).toContain('## Flutter\n\n### Acceptance criteria\n\n## Out of scope');
    expect(markdown).not.toContain('## Mobile');
    expect(markdown).not.toContain('## Front-End');

    const none = '00000000-0000-4000-8000-0000000000ff';
    expect((await asPim('GET', `/features/${none}/spec-template`)).status).toBe(404);
  });
});
