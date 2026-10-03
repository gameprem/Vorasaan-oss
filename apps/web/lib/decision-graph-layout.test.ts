import { describe, expect, test } from 'bun:test';
import type { DecisionGraphBranch, DecisionGraphNode, DecisionGraphView } from '@vorasaan/shared';
import { layoutDecisionGraph, moveFocus, requestKey, versionKey } from './decision-graph-layout';

const person = { id: '00000000-0000-4000-8000-000000000101', name: 'Pim' };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, minute)).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function node(version: number, minute: number): DecisionGraphNode {
  return {
    id: id(100 + version),
    version,
    source: 'MANUAL',
    summary: null,
    revertedFrom: null,
    approvedBy: person,
    createdAt: at(minute),
    requestId: null,
  };
}

function branch(
  n: number,
  sent: number,
  from: number | null,
  end: { to?: number; endedAt?: number; open?: boolean },
): DecisionGraphBranch {
  return {
    requestId: id(n),
    kind: 'QUESTION',
    title: `Request ${n}`,
    status: end.open ? 'OPEN' : end.to ? 'SPEC_UPDATED' : 'DECIDED',
    state: end.open ? 'WAITING' : end.to ? 'MERGED' : 'CLOSED',
    raiser: person,
    decider: person,
    deciderRole: 'PO',
    sentAt: at(sent),
    endedAt: end.endedAt === undefined ? null : at(end.endedAt),
    fromVersion: from,
    toVersion: end.to ?? null,
    decision: null,
    specProposalId: null,
    redrafts: [],
    responseWindow: null,
    labels: [],
  };
}

const view = (nodes: DecisionGraphNode[], branches: DecisionGraphBranch[]): DecisionGraphView => ({
  featureId: id(1),
  nodes,
  branches,
});

describe('Decision Graph layout', () => {
  test('versions take columns in time order on the main lane; branches fork and merge at theirs', () => {
    const layout = layoutDecisionGraph(
      view(
        [node(1, 0), node(2, 10), node(3, 20)],
        [branch(1, 5, 1, { to: 2, endedAt: 10 }), branch(2, 12, 2, { to: 3, endedAt: 20 })],
      ),
    );
    expect(layout.nodes.map((n) => [n.key, n.col])).toEqual([
      ['v1', 0],
      ['v2', 2],
      ['v3', 4],
    ]);
    // The second branch starts after the first has merged: it reuses lane 1.
    expect(layout.branches.map((b) => [b.col, b.lane])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    const [first] = layout.branches;
    // From v1 (x 24) down to lane 1, along it, then up into v2 (x 112).
    expect(first?.path.startsWith('M 24 30 V')).toBe(true);
    expect(first?.path.endsWith('Q 112 66 112 54 V 30')).toBe(true);
  });

  test('overlapping branches take separate lanes; open ones run on to "now"', () => {
    const layout = layoutDecisionGraph(
      view(
        [node(1, 0), node(2, 30)],
        [
          branch(1, 5, 1, { open: true }),
          branch(2, 10, 1, { to: 2, endedAt: 30 }),
          branch(3, 40, 2, { endedAt: 50 }),
        ],
      ),
    );
    expect(layout.branches.map((b) => [b.branch.title, b.lane])).toEqual([
      ['Request 1', 1],
      ['Request 2', 2],
      ['Request 3', 2],
    ]);
    const open = layout.branches[0];
    // Columns: v1, sent 1, sent 2, v2, sent 3, closed 3, then "now".
    expect(open?.open).toBe(true);
    expect(open?.endX).toBe(24 + 6 * 44);
    // A closed branch ends at its own column, with no merge back.
    const closed = layout.branches[2];
    expect(closed?.path.endsWith(`H ${24 + 5 * 44}`)).toBe(true);
  });

  test('a request sent before the first Spec Version forks from the empty Spec', () => {
    const layout = layoutDecisionGraph(
      view([node(1, 20)], [branch(1, 5, null, { to: 1, endedAt: 20 })]),
    );
    expect(layout.origin).toEqual({ x: 24, y: 30 });
    expect(layout.nodes[0]?.col).toBe(2);
    expect(layout.branches[0]?.col).toBe(1);
  });

  test('arrow keys move along a lane and to the nearest node on the next lane', () => {
    const items = [
      { key: versionKey(1), lane: 0, col: 0 },
      { key: versionKey(2), lane: 0, col: 3 },
      { key: requestKey('a'), lane: 1, col: 1 },
      { key: requestKey('b'), lane: 2, col: 4 },
    ];
    expect(moveFocus(items, 'v1', 'ArrowRight')).toBe('v2');
    expect(moveFocus(items, 'v2', 'ArrowRight')).toBeNull();
    expect(moveFocus(items, 'v2', 'ArrowLeft')).toBe('v1');
    expect(moveFocus(items, 'v1', 'ArrowDown')).toBe('r:a');
    expect(moveFocus(items, 'r:a', 'ArrowDown')).toBe('r:b');
    expect(moveFocus(items, 'r:b', 'ArrowUp')).toBe('r:a');
    expect(moveFocus(items, 'r:a', 'ArrowUp')).toBe('v1');
    expect(moveFocus(items, 'v1', 'End')).toBe('v2');
    expect(moveFocus(items, 'v1', 'ArrowUp')).toBeNull();
  });
});
