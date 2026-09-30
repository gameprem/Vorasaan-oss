'use client';

import type {
  EffectiveGuidelineCriterion,
  FeatureFitView,
  GuidelineFitVerdict,
} from '@vorasaan/shared';
import { useActionState, useState, useTransition } from 'react';
import type { FormState } from '@/lib/org-actions';
import { checkFeatureFit } from '@/lib/project-actions';
import { EffectiveGuidelinesList } from './guidelines-list';
import { field, primaryButton, secondaryButton } from './ui';

const VERDICT: Record<GuidelineFitVerdict, { text: string; className: string }> = {
  MET: { text: 'Met', className: 'bg-jade-wash text-jade' },
  UNCLEAR: { text: 'Unclear', className: 'border border-rule text-ink-soft' },
  NOT_MET: { text: 'Not met', className: 'bg-seal-wash text-seal' },
};

/**
 * Creating a Feature by hand: the Project's effective Feature Guidelines, and "Check fit",
 * which asks the AI how the title and description meet each criterion before saving.
 */
export function NewFeatureForm({
  projectId,
  guidelines,
  guidelinesError,
  createAction,
}: {
  projectId: string;
  guidelines: EffectiveGuidelineCriterion[];
  guidelinesError?: string;
  createAction: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fit, setFit] = useState<{ result?: FeatureFitView; error?: string; for?: string }>({});
  const [checking, startCheck] = useTransition();
  const [state, create, creating] = useActionState<FormState, FormData>(createAction, {});
  const current = `${title}\n${description}`;

  const check = () =>
    startCheck(async () => {
      if (!title.trim()) return setFit({ error: 'Give the Feature a title first.' });
      const reply = await checkFeatureFit(projectId, { title, description });
      setFit({ result: reply.fit, error: reply.error, for: current });
    });

  return (
    <form action={create} className="rounded-xl border border-rule bg-sheet p-5">
      <h3 className="font-semibold">New Feature</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem]">
        <label className="block">
          <span className="text-sm">Title</span>
          <input
            name="title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Async checkout"
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-sm">Jira Epic (optional)</span>
          <input name="jiraIssueKey" placeholder="MB-42" className={field} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-sm">Description (optional, used by Check fit)</span>
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What it does, for whom, and why now"
            className={field}
          />
        </label>
      </div>

      <section aria-labelledby="new-feature-guidelines" className="mt-5">
        <h4 id="new-feature-guidelines" className="text-sm font-semibold">
          Feature Guidelines for this Project
        </h4>
        {guidelinesError ? (
          <p role="alert" className="mt-1 text-sm text-seal">
            {guidelinesError}
          </p>
        ) : guidelines.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">
            This Project has no Feature Guidelines, so there is nothing to check.
          </p>
        ) : (
          <div className="mt-2 text-sm">
            <EffectiveGuidelinesList criteria={guidelines} showOrigin={false} />
          </div>
        )}
      </section>

      {fit.result && (
        <section aria-labelledby="fit-heading" className="mt-5" aria-live="polite">
          <h4 id="fit-heading" className="text-sm font-semibold">
            Fit check{fit.for !== current && ' (the title or description changed since)'}
          </h4>
          {fit.result.results.length === 0 ? (
            <p className="mt-1 text-sm text-ink-soft">No Feature Guidelines to check against.</p>
          ) : (
            <ul className="mt-2 divide-y divide-rule border-y border-rule">
              {fit.result.results.map((r) => (
                <li key={r.guidelineId} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT[r.verdict].className}`}
                    >
                      {VERDICT[r.verdict].text}
                    </span>
                    <span className="font-medium">{r.title}</span>
                    {r.required && <span className="text-xs text-ink-soft">Required</span>}
                  </div>
                  <p className="mt-1 text-sm text-ink-soft">{r.reason}</p>
                </li>
              ))}
            </ul>
          )}
          {fit.result.questions.length > 0 && (
            <>
              <p className="mt-3 text-sm font-medium">Questions to settle</p>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {fit.result.questions.map((q) => (
                  <li key={`${q.guidelineId}:${q.question}`}>{q.question}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {fit.error && (
        <p role="alert" className="mt-3 text-sm text-seal">
          {fit.error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        {guidelines.length > 0 && (
          <button
            type="button"
            onClick={check}
            disabled={checking || creating}
            className={secondaryButton}
          >
            {checking ? 'Checking…' : 'Check fit'}
          </button>
        )}
        <button type="submit" disabled={creating || checking} className={primaryButton}>
          {creating ? 'Creating…' : 'Create Feature'}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}
