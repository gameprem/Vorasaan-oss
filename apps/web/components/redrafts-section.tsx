import type { ProposalKind, ProposalRedraftsView } from '@vorasaan/shared';
import { api } from '@/lib/api';
import type { PointerOption } from '@/lib/redrafts';
import { REDRAFT_SLUG, redraftApiBase } from '@/lib/redrafts';
import { ProposalRedrafts } from './redrafts';

/** A proposal's Redrafts, as the API lists them for the viewer; null when they can't load. */
export async function loadRedrafts(
  kind: ProposalKind,
  id: string,
): Promise<ProposalRedraftsView | null> {
  try {
    return await api<ProposalRedraftsView>(`${redraftApiBase(REDRAFT_SLUG[kind], id)}/redrafts`);
  } catch {
    return null;
  }
}

/**
 * Request changes and the Redrafts (ticket 0065) of a proposal shown on a server-rendered
 * page. Optional: when they can't load, the page goes on without them.
 */
export async function RedraftsSection({
  kind,
  id,
  pointers,
  redrafts,
}: {
  kind: ProposalKind;
  id: string;
  pointers?: PointerOption[];
  /** Already loaded by the page. */
  redrafts?: ProposalRedraftsView | null;
}) {
  const loaded = redrafts ?? (await loadRedrafts(kind, id));
  if (!loaded) return null;
  return <ProposalRedrafts kind={kind} proposalId={id} redrafts={loaded} pointers={pointers} />;
}
