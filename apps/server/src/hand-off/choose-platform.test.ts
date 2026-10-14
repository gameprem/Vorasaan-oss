import { describe, expect, test } from 'bun:test';
import type { TeamRole } from '@vorasaan/shared';
import { chooseHandOffPlatform, type HandOffTarget, parseHints } from './choose-platform.ts';

const backEnd: HandOffTarget = { id: 'b', name: 'Back-End', roles: ['BACKEND'] };
const web: HandOffTarget = { id: 'w', name: 'Front-End', roles: ['FRONTEND'] };
const flutter: HandOffTarget = { id: 'f', name: 'Flutter app', roles: ['MOBILE', 'FRONTEND'] };
const targets = [backEnd, web, flutter];
const choose = (roles: TeamRole[], extra: { asked?: string; hints?: string[] } = {}) =>
  chooseHandOffPlatform({ targets, roles: new Set(roles), ...extra });

describe('chooseHandOffPlatform (ticket 0079)', () => {
  test("one Team Role's Platform; among several, the changed files, else the Project's order", () => {
    expect(choose(['BACKEND'])).toMatchObject({ key: 'b', chosenBy: 'TEAM_ROLE' });
    expect(choose(['FRONTEND'])).toMatchObject({ key: 'w', chosenBy: 'TEAM_ROLE' });
    expect(choose(['FRONTEND'], { hints: ['Flutter app'] })).toMatchObject({
      key: 'f',
      chosenBy: 'CHANGED_FILES',
    });
    // A hint outside the developer's Platforms doesn't override their Team Role.
    expect(choose(['BACKEND'], { hints: ['Front-End'] })).toMatchObject({ key: 'b' });
  });

  test('Tech Lead alone picks nothing; QA picks the QA Design Doc', () => {
    expect(choose(['TECH_LEAD'])).toBeNull();
    expect(choose(['TECH_LEAD'], { hints: ['back-end'] })).toMatchObject({
      key: 'b',
      chosenBy: 'CHANGED_FILES',
    });
    expect(choose(['QA', 'PO'])).toEqual({
      key: 'qa',
      name: 'QA',
      platform: null,
      chosenBy: 'TEAM_ROLE',
    });
  });

  test('asked by id or name in any case, qa, none; an untargeted one is a 400', () => {
    expect(choose(['BACKEND'], { asked: 'FLUTTER APP' })).toMatchObject({
      key: 'f',
      chosenBy: 'ASKED',
    });
    expect(choose([], { asked: 'w' })).toMatchObject({ key: 'w' });
    expect(choose(['BACKEND'], { asked: 'QA' })?.key).toBe('qa');
    expect(choose(['BACKEND'], { asked: 'None' })).toBeNull();
    expect(() => choose([], { asked: 'Mobile' })).toThrow(
      'Ask for one of: Back-End, Front-End, Flutter app, qa, none',
    );
  });

  test('the only target, else none; hints are split on commas', () => {
    expect(
      chooseHandOffPlatform({ targets: [web], roles: new Set<TeamRole>(['PO']) }),
    ).toMatchObject({ key: 'w', chosenBy: 'ONLY_TARGET' });
    expect(chooseHandOffPlatform({ targets: [], roles: new Set<TeamRole>(['PO']) })).toBeNull();
    expect(parseHints(' Back-End, ,Front-End ')).toEqual(['Back-End', 'Front-End']);
    expect(parseHints(undefined)).toEqual([]);
  });
});
