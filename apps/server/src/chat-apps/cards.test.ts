import { describe, expect, test } from 'bun:test';
import { lineBubble } from './adapters/line.ts';
import { slackBlocks } from './adapters/slack.ts';
import { adaptiveCard } from './adapters/teams.ts';
import { type CardRequest, decisionCard } from './cards.ts';

const request: CardRequest = {
  id: 'r1',
  kind: 'BLOCKER',
  title: 'Use <!channel> & polling?',
  featureTitle: 'Async checkout',
  raiserName: 'Beam',
  dueAt: new Date('2026-10-02T10:00:00Z'),
  paused: false,
  choices: ['A', 'B'].map((label) => ({
    id: `c${label}`,
    label,
    title: `Option ${label}`,
    impactScope: `Scope ${label}`,
    impactTime: '+1 day',
    impactRisk: 'Low',
  })),
};
const sign = (action: { kind: string; choiceId?: string }) =>
  `token:${action.kind}:${action.choiceId ?? '-'}`;
const now = new Date('2026-10-02T08:00:00Z');

describe('cards (ticket 0058)', () => {
  test('the due time follows the person’s language and time zone', () => {
    const en = decisionCard(request, { lang: 'en', timeZone: 'Asia/Bangkok', now }, sign);
    expect(en.card?.lines).toEqual(['From Beam', 'Due Fri 2 Oct, 17:00 (in 2h)']);
    const th = decisionCard(request, { lang: 'th', timeZone: 'Asia/Bangkok', now }, sign);
    expect(th.card?.lines[0]).toBe('จาก Beam');
    expect(th.card?.lines[1]).toContain('(อีก 2 ชม.)');
    expect(th.card?.eyebrow).toBe('Blocker (งานหยุดรอ) · Async checkout');
  });

  test('Slack text is escaped, so a title can’t mention @channel or become a link', () => {
    const { card } = decisionCard(request, { lang: 'en', timeZone: 'UTC', now }, sign);
    const json = JSON.stringify(slackBlocks(card as NonNullable<typeof card>));
    expect(json).toContain('Use &lt;!channel&gt; &amp; polling?');
    expect(json).not.toContain('<!channel>');
  });

  test('LINE button labels stay within 20 characters; Teams submits carry the token', () => {
    const { card } = decisionCard(request, { lang: 'th', timeZone: 'UTC', now }, sign);
    const bubble = lineBubble(card as NonNullable<typeof card>) as {
      footer: { contents: { action: { label: string; data?: string } }[] };
    };
    for (const { action } of bubble.footer.contents) {
      expect([...action.label].length).toBeLessThanOrEqual(20);
    }
    expect(bubble.footer.contents[0]?.action.data).toBe('token:choice:cA');
    const teams = JSON.stringify(adaptiveCard(card as NonNullable<typeof card>));
    expect(teams).toContain('{"vorasaan":"token:choice:cB"}');
    expect(teams).toContain('{"vorasaan":"token:ask:-"}');
  });
});
