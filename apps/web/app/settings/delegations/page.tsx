import type { DelegationView, ProjectView, TeamView } from '@vorasaan/shared';
import { redirect, unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { DelegationForm, type DelegationTeam } from '@/components/delegation-form';
import { DelegationList } from '@/components/delegation-list';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Delegations' };

export default async function DelegationsPage() {
  const me = await currentUser();
  if (!me) redirect('/login');

  let given: DelegationView[];
  let received: DelegationView[];
  let teams: DelegationTeam[];
  try {
    let projects: ProjectView[];
    [given, received, projects] = await Promise.all([
      api<DelegationView[]>('/me/delegations?as=delegator'),
      api<DelegationView[]>('/me/delegations?as=delegate'),
      api<ProjectView[]>('/projects'),
    ]);
    const all = await Promise.all(
      projects.flatMap((p) =>
        p.teams.map(async (t) => {
          const { members } = await api<TeamView>(`/teams/${t.id}`);
          return { id: t.id, name: t.name, members, projectName: p.name };
        }),
      ),
    );
    teams = all.filter((t) => t.members.some((m) => m.userId === me.id));
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load your Delegations.'}
      </Notice>
    );
  }
  const teamNames = Object.fromEntries(teams.map((t) => [t.id, `${t.projectName} / ${t.name}`]));

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Delegations</h1>
      <p className="mt-2 text-ink-soft">
        Going on leave? Name a Delegate for your Team Role. While it is active, Decision Requests
        sent to you for that Team Role in that Team go to your Delegate, who decides on your behalf.
      </p>

      <h2 className="mt-10 text-lg font-semibold">My Delegations</h2>
      <div className="mt-3">
        <DelegationList
          delegations={given}
          teamNames={teamNames}
          empty="You have no current or upcoming Delegations."
        />
      </div>

      <h2 className="mt-10 text-lg font-semibold">Name a Delegate</h2>
      <div className="mt-3">
        {teams.length === 0 ? (
          <p className="text-ink-soft">
            You are not in any Team yet. Ask an Admin or your Team's PO to add you.
          </p>
        ) : (
          <DelegationForm teams={teams} meId={me.id} />
        )}
      </div>

      {received.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold">Delegated to me</h2>
          <div className="mt-3">
            <DelegationList
              delegations={received}
              teamNames={teamNames}
              empty="Nobody has named you as their Delegate."
            />
          </div>
        </>
      )}
    </section>
  );
}
