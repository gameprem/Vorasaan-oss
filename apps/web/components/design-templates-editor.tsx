'use client';

import {
  DESIGN_TEMPLATE_LABEL,
  type DesignTemplateView,
  MAX_DESIGN_TEMPLATE_CHARS,
} from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import { saveDesignTemplate } from '@/lib/design-doc-actions';
import { field } from './ui';
import { Button } from './ui/button';

// A Project's Design Doc templates (ADR 0014, ticket 0069): one per kind of Platform and QA's,
// each built in until the Project's POs or Admins edit it. Each `##` section is a part of the
// design the AI fills from the approved Spec. A draft written after a save uses it.

const HINT: Record<DesignTemplateView['kind'], string> = {
  BACK_END: 'API contract, data model, sequences, error cases.',
  FRONT_END: 'Screens and states, API calls, validation.',
  MOBILE: 'As Front-End, plus offline and push.',
  QA: 'A test plan, and test cases traced to the Spec’s acceptance criteria.',
};

function TemplateField({
  projectId,
  template,
  canEdit,
}: {
  projectId: string;
  template: DesignTemplateView;
  canEdit: boolean;
}) {
  const id = useId();
  const [markdown, setMarkdown] = useState(template.markdown);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const label = DESIGN_TEMPLATE_LABEL[template.kind];
  const run = (value: string | null, done: string) =>
    start(async () => {
      setMessage(null);
      const result = await saveDesignTemplate(projectId, template.kind, value);
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: done });
    });
  return (
    <section aria-labelledby={`${id}-h`} className="py-5">
      <h3 id={`${id}-h`} className="font-semibold">
        {label} template{' '}
        <span className="text-sm font-normal text-fg-soft">
          {template.builtIn ? '(built in)' : '(edited for this Project)'}
        </span>
      </h3>
      <p className="text-sm text-fg-soft">{HINT[template.kind]}</p>
      {canEdit ? (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(markdown, `The ${label} template is saved. Drafts from now on use it.`);
          }}
        >
          <label htmlFor={id} className="sr-only">
            {label} template (Markdown)
          </label>
          <textarea
            id={id}
            className={`${field} font-mono text-sm`}
            rows={8}
            maxLength={MAX_DESIGN_TEMPLATE_CHARS}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" isDisabled={pending}>
              Save the {label} template
            </Button>
            {!template.builtIn && (
              <Button
                size="sm"
                isDisabled={pending}
                onPress={() => run(null, `The ${label} template is the built-in one again.`)}
              >
                Use the built-in one
              </Button>
            )}
          </div>
        </form>
      ) : (
        <pre className="mt-2 overflow-x-auto rounded-xl bg-surface p-4 text-sm whitespace-pre-wrap">
          {template.markdown}
        </pre>
      )}
      <p role="status" className="mt-2 text-sm text-jade empty:hidden">
        {message?.ok ? message.text : ''}
      </p>
      <p role="alert" className="mt-2 text-sm text-lacquer empty:hidden">
        {message && !message.ok ? message.text : ''}
      </p>
    </section>
  );
}

export function DesignTemplatesEditor({
  projectId,
  templates,
  canEdit,
}: {
  projectId: string;
  templates: DesignTemplateView[];
  canEdit: boolean;
}) {
  return (
    <div className="rows">
      {templates.map((t) => (
        <TemplateField key={t.kind} projectId={projectId} template={t} canEdit={canEdit} />
      ))}
    </div>
  );
}
