import type { AgentSkillDiff, AgentSkillsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { AgentSkillsSettings } from '@/components/agent-skills-settings';
import { Notice } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Agent Skills' };

export default async function AgentSkillsPage() {
  let view: AgentSkillsView;
  const diffs: Record<string, AgentSkillDiff> = {};
  try {
    view = await api<AgentSkillsView>('/settings/agent-skills');
    // What each version waiting for approval holds, against the one in use.
    const pending = view.skills.filter((s) => s.pending);
    const loaded = await Promise.all(
      pending.map((s) => api<AgentSkillDiff>(`/settings/agent-skills/${s.id}/diff`)),
    );
    pending.forEach((s, i) => {
      const diff = loaded[i];
      if (diff) diffs[s.id] = diff;
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can install and approve Agent Skills.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Agent Skills.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Agent Skills</h2>
      <p className="mt-2 text-fg-soft">
        Agent Skills teach the AI to make something in a particular way, such as drawing a diagram,
        in the open SKILL.md format. The AI sees an approved Skill only in the Projects it is
        enabled in, reads it only when it needs it, and what it makes with one is only ever a
        proposal a person approves. Skills are text and templates: nothing in them is ever run.
      </p>
      <AgentSkillsSettings view={view} diffs={diffs} />
    </section>
  );
}
