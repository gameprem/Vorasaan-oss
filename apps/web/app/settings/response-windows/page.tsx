import {
  type ProjectResponseWindowsView,
  type ProjectView,
  type ResponseWindowSettingsView,
  responseWindowText,
} from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import {
  ProjectResponseWindowsEditor,
  ResponseWindowSettingsEditor,
} from '@/components/response-windows-settings';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Response Windows' };

const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default async function ResponseWindowsSettingsPage() {
  let settings: ResponseWindowSettingsView;
  let isAdmin: boolean;
  let projects: { project: ProjectView; windows: ProjectResponseWindowsView }[] = [];
  try {
    const [loaded, me] = await Promise.all([
      api<ResponseWindowSettingsView>('/settings/response-windows'),
      currentUser(),
    ]);
    settings = loaded;
    isAdmin = me?.isAdmin ?? false;
    if (isAdmin) {
      const list = await api<ProjectView[]>('/projects');
      projects = await Promise.all(
        list.map(async (project) => ({
          project,
          windows: await api<ProjectResponseWindowsView>(
            `/projects/${project.id}/response-windows`,
          ),
        })),
      );
    }
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Response Windows.'}
      </Notice>
    );
  }

  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Response Windows</h2>
      <p className="mt-2 text-fg-soft">
        How long a Decision Request may wait for a decision, in working time. When it runs out the
        Recipients are reminded; half a window later each Recipient's active Delegate is added; half
        a window after that the Raiser and the Team's Tech Leads are told. Nobody but a person ever
        decides or reassigns it.
      </p>
      <div className="mt-8">
        {isAdmin ? (
          <>
            <ResponseWindowSettingsEditor settings={settings} />
            {projects.length > 0 && (
              <section className="mt-10" aria-labelledby="project-windows">
                <h3 id="project-windows" className="text-lg font-semibold">
                  Projects
                </h3>
                <p className="mt-1 text-fg-soft">
                  A Project can give its Blockers or Questions their own window. The Raiser can
                  still shorten it when sending.
                </p>
                <div className="mt-2 rows">
                  {projects.map(({ project, windows }) => (
                    <ProjectResponseWindowsEditor
                      key={project.id}
                      projectName={project.name}
                      windows={windows}
                      defaults={{ blocker: settings.blocker, question: settings.question }}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            <Notice>Only an Organization Admin can change the Response Windows.</Notice>
            <dl className="mt-6 grid grid-cols-[10rem_1fr] gap-y-2">
              <dt className="text-fg-soft">Time zone</dt>
              <dd>{settings.timeZone}</dd>
              <dt className="text-fg-soft">Working time</dt>
              <dd>
                {settings.workingDays.map((d) => WEEKDAY[d]).join(', ')}, {settings.workStart}–
                {settings.workEnd}
              </dd>
              <dt className="text-fg-soft">Blocker</dt>
              <dd>{responseWindowText(settings.blocker)}</dd>
              <dt className="text-fg-soft">Question</dt>
              <dd>{responseWindowText(settings.question)}</dd>
              <dt className="text-fg-soft">Holidays</dt>
              <dd>
                {settings.holidays.length
                  ? settings.holidays.map((h) => `${h.date} ${h.name}`).join(', ')
                  : 'None'}
              </dd>
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
