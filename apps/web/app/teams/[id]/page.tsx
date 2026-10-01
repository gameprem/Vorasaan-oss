import type {
  DelegationView,
  EffectiveFeatureGuidelinesView,
  OrgMemberView,
  TeamView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { BlockedBadge, Notice } from '@/components/bits';
import { DelegationForm } from '@/components/delegation-form';
import { DelegationList } from '@/components/delegation-list';
import { NewFeatureForm } from '@/components/new-feature-form';
import { TeamRolesEditor } from '@/components/team-roles-editor';
import { ROLE_LABEL } from '@/components/ui';
import { ApiError, api, currentUser } from '@/lib/api';
import { createFeature } from '@/lib/org-actions';

export const metadata = { title: 'Team' };

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let team: TeamView;
  let members: OrgMemberView[];
  let delegations: DelegationView[] | string;
  try {
    [team, members, delegations] = await Promise.all([
      api<TeamView>(`/teams/${id}`),
      api<OrgMemberView[]>('/members'),
      // Not being able to list Delegations should not hide the rest of the Team.
      api<DelegationView[]>(`/teams/${id}/delegations`).catch((error: unknown) => {
        unstable_rethrow(error);
        return error instanceof ApiError ? error.message : 'Could not load Delegations.';
      }),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
  const me = await currentUser();
  // The effective Feature Guidelines, shown while creating a Feature; a failure only hides them.
  const guidelines = team.canManage
    ? await api<EffectiveFeatureGuidelinesView>(
        `/projects/${team.project.id}/feature-guidelines/effective`,
      ).catch((error: unknown) => {
        unstable_rethrow(error);
        return error instanceof ApiError ? error.message : 'Could not load the Feature Guidelines.';
      })
    : null;

  return (
    <section className="max-w-4xl">
      <p className="text-sm text-fg-soft">
        <Link href={`/projects/${team.project.id}`} className="hover:underline">
          {team.project.name}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{team.name} team</h1>

      <h2 className="mt-10 text-lg font-semibold">Features</h2>
      {team.features.length === 0 ? (
        <p className="mt-2 text-fg-soft">No Features yet.</p>
      ) : (
        <ul className="mt-3 rows">
          {team.features.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3">
              <Link
                href={`/features/${f.id}`}
                className="block flex-1 py-3 font-medium hover:underline"
              >
                {f.title}
              </Link>
              <BlockedBadge openBlockers={f.openBlockers} />
            </li>
          ))}
        </ul>
      )}
      {team.canManage && (
        <div className="mt-6">
          <NewFeatureForm
            projectId={team.project.id}
            guidelines={guidelines && typeof guidelines !== 'string' ? guidelines.criteria : []}
            guidelinesError={typeof guidelines === 'string' ? guidelines : undefined}
            createAction={createFeature.bind(null, team.id)}
          />
        </div>
      )}

      <h2 className="mt-12 text-lg font-semibold">Members and Team Roles</h2>
      <div className="mt-4">
        {team.canManage ? (
          <TeamRolesEditor team={team} orgMembers={members} />
        ) : team.members.length === 0 ? (
          <p className="text-fg-soft">No members yet.</p>
        ) : (
          <ul className="rows">
            {team.members.map((m) => (
              <li key={m.userId} className="flex justify-between py-3">
                <span className="font-medium">{m.name}</span>
                <span className="text-fg-soft">{m.roles.map((r) => ROLE_LABEL[r]).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 className="mt-12 text-lg font-semibold">Delegations</h2>
      <p className="mt-1 text-sm text-fg-soft">
        Who decides for whom while someone is away. Set your own in{' '}
        <Link href="/settings/delegations" className="underline underline-offset-2">
          Settings → Delegations
        </Link>
        .
      </p>
      <div className="mt-4">
        {typeof delegations === 'string' ? (
          <Notice tone="error">{delegations}</Notice>
        ) : (
          <DelegationList
            delegations={delegations}
            empty="No current or upcoming Delegations in this Team."
          />
        )}
      </div>
      {me?.isAdmin && team.members.length > 1 && (
        <div className="mt-6">
          <h3 className="font-semibold">Name a Delegate for a member</h3>
          <div className="mt-3">
            <DelegationForm
              teams={[
                {
                  id: team.id,
                  name: team.name,
                  members: team.members,
                  projectName: team.project.name,
                },
              ]}
              meId={me.id}
              forAnyone
            />
          </div>
        </div>
      )}
    </section>
  );
}
