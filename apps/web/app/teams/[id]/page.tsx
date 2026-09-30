import type { OrgMemberView, TeamView } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { BlockedBadge } from '@/components/bits';
import { TeamRolesEditor } from '@/components/team-roles-editor';
import { field, ROLE_LABEL } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { createFeature } from '@/lib/org-actions';

export const metadata = { title: 'Team' };

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let team: TeamView;
  let members: OrgMemberView[];
  try {
    [team, members] = await Promise.all([
      api<TeamView>(`/teams/${id}`),
      api<OrgMemberView[]>('/members'),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }

  return (
    <section className="max-w-4xl">
      <p className="text-sm text-ink-soft">
        <Link href="/projects" className="hover:underline">
          {team.project.name}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{team.name} team</h1>

      <h2 className="mt-10 text-lg font-semibold">Features</h2>
      {team.features.length === 0 ? (
        <p className="mt-2 text-ink-soft">No Features yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule border-y border-rule">
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
          <ActionForm
            action={createFeature.bind(null, team.id)}
            submitLabel="Create Feature"
            pendingLabel="Creating…"
          >
            <label className="min-w-64 flex-1">
              <span className="text-sm">New Feature</span>
              <input name="title" required placeholder="Async checkout" className={field} />
            </label>
            <label className="w-40">
              <span className="text-sm">Jira Epic (optional)</span>
              <input name="jiraIssueKey" placeholder="MB-42" className={field} />
            </label>
          </ActionForm>
        </div>
      )}

      <h2 className="mt-12 text-lg font-semibold">Members and Team Roles</h2>
      <div className="mt-4">
        {team.canManage ? (
          <TeamRolesEditor team={team} orgMembers={members} />
        ) : team.members.length === 0 ? (
          <p className="text-ink-soft">No members yet.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {team.members.map((m) => (
              <li key={m.userId} className="flex justify-between py-3">
                <span className="font-medium">{m.name}</span>
                <span className="text-ink-soft">
                  {m.roles.map((r) => ROLE_LABEL[r]).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
