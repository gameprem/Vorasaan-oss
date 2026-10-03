import {
  type DecisionGraphBranch,
  type DecisionGraphNode,
  type DecisionGraphView,
  OPEN_BRANCH_STATES,
} from '@vorasaan/shared';

// Lays out a Decision Graph (ticket 0067) like a git network graph: time runs left to right
// in columns, the Spec Versions sit on the main lane at the top, and each Decision Request
// takes the first lane below that is free from the column it was sent in to the column it
// merged or closed in. Open requests run on to the last column, "now".

/** Distance between columns and between lanes, and the margins around them. */
export const GRAPH = { col: 44, lane: 36, padX: 24, padTop: 30, padBottom: 18, radius: 12 };

export type LaidNode = {
  key: string;
  node: DecisionGraphNode;
  lane: 0;
  col: number;
  x: number;
  y: number;
};

export type LaidBranch = {
  key: string;
  branch: DecisionGraphBranch;
  lane: number;
  col: number;
  /** Where the request sits on its lane. */
  x: number;
  y: number;
  /** From the fork on the main lane to the merge, the closing cap or "now". */
  path: string;
  open: boolean;
  /** Where the branch ends on its lane: the closing cap, the merge's turn, or "now". */
  endX: number;
  /** Redraft marks along the lane. */
  marks: number[];
};

export type GraphLayout = {
  width: number;
  height: number;
  /** The main lane's y, and where it starts and ends. */
  mainY: number;
  mainFrom: number;
  mainTo: number;
  /** Where the empty Spec starts the main lane, when a request was sent before v1. */
  origin: { x: number; y: number } | null;
  nodes: LaidNode[];
  branches: LaidBranch[];
};

/** A Spec Version's key in the layout and in keyboard navigation. */
export const versionKey = (version: number) => `v${version}`;
/** A Decision Request's key. */
export const requestKey = (requestId: string) => `r:${requestId}`;

const time = (iso: string) => Date.parse(iso);

export function layoutDecisionGraph(graph: DecisionGraphView): GraphLayout {
  const { col, lane, padX, padTop, padBottom, radius } = GRAPH;
  const hasOrigin = graph.branches.some((b) => b.fromVersion === null);

  // Every event gets its own column, in time order. On a tie a version comes first, then a
  // request being sent, then one closing, so a branch never starts before its fork.
  type Event = { at: number; rank: number; key: string };
  const events: Event[] = [
    ...graph.nodes.map((n) => ({ at: time(n.createdAt), rank: 0, key: versionKey(n.version) })),
    ...graph.branches.map((b) => ({ at: time(b.sentAt), rank: 1, key: requestKey(b.requestId) })),
    ...graph.branches
      .filter((b) => b.toVersion === null && b.endedAt !== null)
      .map((b) => ({ at: time(b.endedAt ?? b.sentAt), rank: 2, key: `end:${b.requestId}` })),
  ];
  events.sort((a, b) => a.at - b.at || a.rank - b.rank);
  const first = hasOrigin ? 1 : 0;
  const colOf = new Map(events.map((e, i) => [e.key, i + first]));
  const anyOpen = graph.branches.some((b) => OPEN_BRANCH_STATES.includes(b.state));
  const lastCol = events.length - 1 + first + (anyOpen ? 1 : 0);
  const x = (c: number) => padX + c * col;
  // "Now" for an open branch's Redraft marks: the latest thing the graph knows of, so the
  // server and the browser draw the same picture.
  const latest = Math.max(
    0,
    ...events.map((e) => e.at),
    ...graph.branches.flatMap((b) => b.redrafts.map((m) => time(m.createdAt))),
  );
  const mainY = padTop;
  const y = (l: number) => mainY + l * lane;

  const nodes: LaidNode[] = graph.nodes.map((node) => {
    const c = colOf.get(versionKey(node.version)) ?? 0;
    return { key: versionKey(node.version), node, lane: 0, col: c, x: x(c), y: mainY };
  });
  const nodeCol = new Map(nodes.map((n) => [n.node.version, n.col]));

  // Lanes from 1 down; a lane is free again in the column after a branch on it ends.
  const laneEnds: number[] = [];
  const branches: LaidBranch[] = graph.branches
    .map((branch) => {
      const start = colOf.get(requestKey(branch.requestId)) ?? 0;
      const fork = branch.fromVersion === null ? 0 : (nodeCol.get(branch.fromVersion) ?? 0);
      const open = OPEN_BRANCH_STATES.includes(branch.state);
      const merge = branch.toVersion === null ? null : (nodeCol.get(branch.toVersion) ?? null);
      const end = open
        ? lastCol
        : merge !== null
          ? Math.max(merge, start + 1)
          : (colOf.get(`end:${branch.requestId}`) ?? start);
      return { branch, start, fork, open, merge, end };
    })
    .sort((a, b) => a.start - b.start)
    .map(({ branch, start, fork, open, merge, end }) => {
      let l = laneEnds.findIndex((until) => until < start);
      if (l === -1) l = laneEnds.push(end) - 1;
      else laneEnds[l] = end;
      const lanes = l + 1;
      const by = y(lanes);
      const fx = x(fork);
      const sx = x(start);
      const r = Math.min(radius, lane / 2, Math.max(sx - fx, 1));
      let path = `M ${fx} ${mainY} V ${by - r} Q ${fx} ${by} ${fx + r} ${by} H ${sx}`;
      let endX: number;
      if (merge !== null && !open) {
        const mx = x(end);
        endX = mx - r;
        path += ` H ${mx - r} Q ${mx} ${by} ${mx} ${by - r} V ${mainY}`;
      } else {
        endX = x(end);
        path += ` H ${endX}`;
      }
      // Redrafts sit between sending and the end, by time; one made before sending (on the
      // draft's Choices) sits just after the request.
      const from = time(branch.sentAt);
      const until = branch.endedAt ? time(branch.endedAt) : Math.max(latest, from + 1);
      const span = Math.max(endX - sx - 10, 0);
      const marks = branch.redrafts.map((m) => {
        const share = Math.min(Math.max((time(m.createdAt) - from) / (until - from || 1), 0), 1);
        return sx + 8 + share * span;
      });
      return {
        key: requestKey(branch.requestId),
        branch,
        lane: lanes,
        col: start,
        x: sx,
        y: by,
        path,
        open,
        endX,
        marks,
      };
    });

  const lanesUsed = laneEnds.length;
  return {
    width: x(lastCol) + padX + (anyOpen ? 120 : 0),
    height: y(lanesUsed) + padBottom,
    mainY,
    mainFrom: hasOrigin ? x(0) : (nodes[0]?.x ?? x(0)),
    mainTo: Math.max(x(lastCol), nodes.at(-1)?.x ?? 0),
    origin: hasOrigin ? { x: x(0), y: mainY } : null,
    nodes,
    branches,
  };
}

export type Focusable = { key: string; lane: number; col: number };

/**
 * Where an arrow key moves from `current`: Left and Right along its lane, Up and Down to
 * the nearest node on the next lane that has one, Home and End to the ends of its lane.
 */
export function moveFocus(items: Focusable[], current: string, key: string): string | null {
  const here = items.find((i) => i.key === current);
  if (!here) return items[0]?.key ?? null;
  const onLane = (l: number) => items.filter((i) => i.lane === l).sort((a, b) => a.col - b.col);
  const lane = onLane(here.lane);
  const at = lane.findIndex((i) => i.key === here.key);
  switch (key) {
    case 'ArrowRight':
      return lane[at + 1]?.key ?? null;
    case 'ArrowLeft':
      return lane[at - 1]?.key ?? null;
    case 'Home':
      return lane[0]?.key ?? null;
    case 'End':
      return lane.at(-1)?.key ?? null;
    case 'ArrowDown':
    case 'ArrowUp': {
      const lanes = [...new Set(items.map((i) => i.lane))].sort((a, b) => a - b);
      const next = lanes[lanes.indexOf(here.lane) + (key === 'ArrowDown' ? 1 : -1)];
      if (next === undefined) return null;
      const nearest = onLane(next).reduce<Focusable | null>(
        (best, i) =>
          !best || Math.abs(i.col - here.col) < Math.abs(best.col - here.col) ? i : best,
        null,
      );
      return nearest?.key ?? null;
    }
    default:
      return null;
  }
}
