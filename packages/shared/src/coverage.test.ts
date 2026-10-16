import { describe, expect, test } from 'bun:test';
import {
  hasAcceptanceCriteria,
  hasPlatformSection,
  namesPlatform,
  platformCoverage,
  uncoveredPlatforms,
} from './coverage.ts';
import { coverageGapText } from './coverage-values.ts';
import type { TeamRole } from './enums.ts';
import { specTemplate } from './platform-values.ts';

const flutter = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Flutter',
  roles: ['MOBILE'] as TeamRole[],
  specSection: true,
  someoneToAsk: true,
  noOpenBlockers: true,
  qaReady: true,
};

const SPEC = `# Checkout

## Goal
Pay faster.

## back-end
POST /payments returns 202.

### Acceptance criteria
- [ ] A payment is never confirmed twice.

## Flutter

### Test cases

## Out of scope
- Refunds.
`;

describe('reading a Spec for Coverage (ticket 0051)', () => {
  test('a section matches its Platform ignoring case, and needs content', () => {
    expect(hasPlatformSection(SPEC, 'Back-End')).toBe(true);
    expect(hasPlatformSection(SPEC, 'BACK-END')).toBe(true);
    // Only a heading under it: empty.
    expect(hasPlatformSection(SPEC, 'Flutter')).toBe(false);
    expect(hasPlatformSection(SPEC, 'Mobile')).toBe(false);
    // A `###` heading isn't a Platform section, and fenced code isn't a heading.
    expect(hasPlatformSection('### Flutter\nText', 'Flutter')).toBe(false);
    expect(hasPlatformSection('```\n## Flutter\ntext\n```', 'Flutter')).toBe(false);
    expect(hasPlatformSection('## Flutter ##\n\nText.', 'flutter')).toBe(true);
  });

  test("the Spec template's empty sections and placeholders don't count", () => {
    const template = specTemplate({ title: 'X', platforms: ['Back-End', 'Flutter'] });
    expect(hasPlatformSection(template, 'Back-End')).toBe(false);
    expect(hasAcceptanceCriteria(template, 'Back-End')).toBe(false);
    expect(hasPlatformSection('## Flutter\n\n- [ ] …\n', 'Flutter')).toBe(false);
  });

  test('acceptance criteria or test cases, in English or Thai, with content', () => {
    expect(hasAcceptanceCriteria(SPEC, 'Back-End')).toBe(true);
    expect(hasAcceptanceCriteria(SPEC, 'Flutter')).toBe(false);
    const thai = '## Flutter\nแอปมือถือ\n\n### กรณีทดสอบ\n- กดจ่ายแล้วเห็นสถานะภายใน 1 วินาที\n';
    expect(hasAcceptanceCriteria(thai, 'Flutter')).toBe(true);
    const criteria = '## Flutter\n### เกณฑ์การยอมรับ:\n- [ ] ใช้ได้บน Android 10 ขึ้นไป\n';
    expect(hasAcceptanceCriteria(criteria, 'Flutter')).toBe(true);
    // A subsection of another section, or another subsection title, doesn't count.
    expect(hasAcceptanceCriteria('## Flutter\nText\n### Notes\n- a\n', 'Flutter')).toBe(false);
    expect(hasAcceptanceCriteria('## Acceptance criteria\n- [ ] a\n', 'Flutter')).toBe(false);
  });

  test('a Blocker names a Platform as a whole word, however its words are joined', () => {
    expect(namesPlatform('The backend has no webhook', 'Back-End')).toBe(true);
    expect(namesPlatform('Back end: no webhook', 'Back-End')).toBe(true);
    expect(namesPlatform('Automobile pricing', 'Mobile')).toBe(false);
    expect(namesPlatform('แอป Flutter ค้างตอนจ่ายเงิน', 'Flutter')).toBe(true);
    expect(namesPlatform('แอปมือถือค้าง', 'มือถือ')).toBe(true);
  });
});

describe('evaluating a Platform', () => {
  const base = {
    platform: flutter,
    specMarkdown: `${SPEC}\n## Flutter\nShows the order as Paying.\n\n### Acceptance criteria\n- [ ] Retry is one tap.\n`,
    teamRoles: new Set<TeamRole>(['MOBILE', 'QA']),
    openBlockers: [],
  };

  test('covered when every switched-on check passes', () => {
    expect(platformCoverage(base)).toEqual({
      platform: { id: flutter.id, name: 'Flutter' },
      covered: true,
      checks: ['SPEC_SECTION', 'SOMEONE_TO_ASK', 'NO_OPEN_BLOCKERS', 'QA_READY'],
      missing: [],
    });
  });

  test('each failing check is a reason, and a switched-off check is never one', () => {
    const missing = platformCoverage({
      ...base,
      specMarkdown: SPEC,
      teamRoles: new Set<TeamRole>(['BACKEND']),
      openBlockers: [
        {
          id: '00000000-0000-4000-8000-0000000000b1',
          title: 'Payments',
          choices: ['Drop Flutter'],
        },
        { id: '00000000-0000-4000-8000-0000000000b2', title: 'Web layout', choices: [] },
      ],
    });
    expect(missing.covered).toBe(false);
    expect(missing.missing).toEqual([
      { check: 'SPEC_SECTION' },
      { check: 'SOMEONE_TO_ASK', roles: ['MOBILE'] },
      {
        check: 'NO_OPEN_BLOCKERS',
        blockers: [{ id: '00000000-0000-4000-8000-0000000000b1', title: 'Payments' }],
      },
      { check: 'QA_READY', noCriteria: true, noQa: true },
    ]);
    expect(missing.missing.map(coverageGapText)).toEqual([
      'No Spec section',
      'Nobody in the Team holds MOBILE',
      'An open Blocker: Payments',
      'Missing QA: no acceptance criteria or test cases, and nobody in the Team holds QA',
    ]);

    const off = platformCoverage({
      ...base,
      platform: { ...flutter, specSection: false, someoneToAsk: false },
      specMarkdown: SPEC,
      teamRoles: new Set<TeamRole>(['QA']),
    });
    expect(off.checks).toEqual(['NO_OPEN_BLOCKERS', 'QA_READY']);
    expect(off.missing).toEqual([{ check: 'QA_READY', noCriteria: true, noQa: false }]);
  });

  test('a Platform no Feature covers', () => {
    const backEnd = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Back-End' };
    const flutterRef = { id: flutter.id, name: 'Flutter' };
    const rows = [
      { platforms: [{ platform: backEnd, covered: true, checks: [], missing: [] }] },
      {
        platforms: [
          {
            platform: flutterRef,
            covered: false,
            checks: ['SPEC_SECTION' as const],
            missing: [{ check: 'SPEC_SECTION' as const }],
          },
        ],
      },
    ];
    expect(uncoveredPlatforms([backEnd, flutterRef], rows)).toEqual([flutterRef]);
  });
});
