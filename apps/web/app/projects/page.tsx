import type { ProjectView } from '@vorasaan/shared';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { field } from '@/components/ui';
import { api, currentUser } from '@/lib/api';
import { createProject, createTeam } from '@/lib/org-actions';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const [projects, me] = await Promise.all([api<ProjectView[]>('/projects'), currentUser()]);
  const isAdmin = me?.isAdmin ?? false;

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <p className="mt-2 text-fg-soft">
        A Project is a product you build. Teams inside it own Features.
      </p>

      {projects.length === 0 && (
        <p className="mt-8 text-fg-soft">
          {isAdmin
            ? 'No Projects yet. Create the first one below.'
            : 'No Projects yet. An Admin creates them.'}
        </p>
      )}

      <div className="mt-8 space-y-10">
        {projects.map((p) => (
          <article key={p.id}>
            <h2 className="text-lg font-semibold">
              <Link href={`/projects/${p.id}`} className="underline-offset-2 hover:underline">
                {p.name}
              </Link>
              {p.jiraKey && (
                <span className="ml-2 text-sm font-normal text-fg-soft">Jira {p.jiraKey}</span>
              )}
            </h2>
            <p className="mt-1 text-sm">
              <Link
                href={`/projects/${p.id}`}
                className="text-fg-soft underline underline-offset-2 hover:text-fg"
              >
                Project Brief, Grilling, Guidelines and Feature Suggestions
              </Link>
            </p>
            {p.teams.length === 0 ? (
              <p className="mt-2 text-fg-soft">No Teams yet.</p>
            ) : (
              <ul className="mt-3 rows">
                {p.teams.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex justify-between py-3 hover:underline"
                    >
                      <span className="font-medium">{t.name}</span>
                      <span className="text-sm text-fg-soft">
                        {t.featureCount} {t.featureCount === 1 ? 'Feature' : 'Features'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {isAdmin && (
              <div className="mt-4">
                <ActionForm
                  action={createTeam.bind(null, p.id)}
                  submitLabel="Add Team"
                  pendingLabel="Adding…"
                >
                  <label className="min-w-56 flex-1">
                    <span className="sr-only">New Team name in {p.name}</span>
                    <input
                      name="name"
                      required
                      placeholder="Team name, e.g. Checkout"
                      className={field}
                    />
                  </label>
                </ActionForm>
              </div>
            )}
          </article>
        ))}
      </div>

      {isAdmin && (
        <div className="mt-12 pt-8">
          <h2 className="text-lg font-semibold">New Project</h2>
          <div className="mt-4">
            <ActionForm
              action={createProject}
              submitLabel="Create Project"
              pendingLabel="Creating…"
            >
              <label className="min-w-56 flex-1">
                <span className="text-sm">Name</span>
                <input name="name" required placeholder="Mobile Banking" className={field} />
              </label>
              <label className="w-40">
                <span className="text-sm">Jira key (optional)</span>
                <input name="jiraKey" placeholder="MB" className={field} />
              </label>
            </ActionForm>
          </div>
        </div>
      )}
    </section>
  );
}
