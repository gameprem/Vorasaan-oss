'use client';

import {
  type ChoiceDraft,
  type DecisionRequestView,
  type PersonRef,
  type Recipients,
  type ResponseWindow,
  type ResponseWindowUnit,
  responseWindowText,
  type SubmitDecisionRequestInput,
  TeamRole,
} from '@vorasaan/shared';
import { useActionState, useEffect, useRef, useState } from 'react';
import { type RequestActionState, submitDraft } from '@/lib/request-actions';
import { field, primaryButton, ROLE_LABEL, secondaryButton } from './ui';
import { Radio, RadioGroup } from './ui/radio-group';
import { Select } from './ui/select';

const MIN_CHOICES = 2;
const MAX_CHOICES = 4;
const LABELS = ['A', 'B', 'C', 'D'];
const ALL = 'ALL';

const emptyChoice = (): ChoiceDraft => ({
  label: '',
  title: '',
  description: '',
  impactScope: '',
  impactTime: '',
  impactRisk: '',
});

/**
 * The Raiser reviews a DRAFT: edits, adds or removes Choices, confirms the decider role and
 * picks the recipients. Untouched Choices are sent as the AI drafted them ("send now").
 */
export function DraftReview({
  request,
  candidatesByRole,
  defaultWindow,
}: {
  request: DecisionRequestView;
  /** The Project's Response Window for this kind; the Raiser may only shorten it. */
  defaultWindow?: ResponseWindow;
  /** Who can receive it for each Team Role: the Feature's Role Owners, else the Team's holders. */
  candidatesByRole: Partial<Record<TeamRole, PersonRef[]>>;
}) {
  const [state, run, pending] = useActionState<RequestActionState, SubmitDecisionRequestInput>(
    submitDraft.bind(null, request.id),
    {},
  );

  const [role, setRole] = useState<TeamRole>(request.deciderRole);
  const [recipient, setRecipient] = useState<string>(ALL);
  const [choices, setChoices] = useState<ChoiceDraft[]>(() =>
    request.choices.map(({ label, title, description, impactScope, impactTime, impactRisk }) => ({
      label,
      title,
      description,
      impactScope,
      impactTime,
      impactRisk,
    })),
  );
  const [edited, setEdited] = useState(false);
  const [responseWindow, setResponseWindow] = useState<ResponseWindow | undefined>(defaultWindow);
  const [focusChoice, setFocusChoice] = useState<number | null>(null);
  const choiceList = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (focusChoice === null) return;
    choiceList.current
      ?.querySelector<HTMLInputElement>(`[data-choice="${focusChoice}"] input`)
      ?.focus();
    setFocusChoice(null);
  }, [focusChoice]);

  const candidates = candidatesByRole[role] ?? [];
  const noCandidates = candidates.length === 0;

  const changeRole = (next: TeamRole) => {
    setRole(next);
    setRecipient(ALL);
  };
  const updateChoice = (index: number, key: keyof ChoiceDraft, value: string) => {
    setEdited(true);
    setChoices((prev) => prev.map((c, i) => (i === index ? { ...c, [key]: value } : c)));
  };
  const addChoice = () => {
    setEdited(true);
    setChoices((prev) => [...prev, emptyChoice()]);
    setFocusChoice(choices.length);
  };
  const removeChoice = (index: number) => {
    setEdited(true);
    setChoices((prev) => prev.filter((_, i) => i !== index));
    setFocusChoice(Math.max(0, index - 1));
  };

  const send = () => {
    const recipients: Recipients =
      recipient === ALL || candidates.length === 1 ? ALL : { userId: recipient };
    run({
      deciderRole: role,
      recipients,
      // Letters follow the order on screen, so an added or removed Choice relabels the rest.
      choices: edited ? choices.map((c, i) => ({ ...c, label: LABELS[i] ?? c.label })) : undefined,
      // Only a changed window is sent; the server refuses one longer than the default.
      responseWindow:
        responseWindow &&
        (responseWindow.value !== defaultWindow?.value ||
          responseWindow.unit !== defaultWindow?.unit)
          ? responseWindow
          : undefined,
    });
  };

  return (
    <form action={send} className="mt-8 space-y-10">
      <section aria-labelledby="send-to">
        <h2 id="send-to" className="text-lg font-semibold">
          Who decides
        </h2>
        <p className="mt-1 text-fg-soft">
          {request.suggestedRole
            ? `The AI suggests the ${ROLE_LABEL[request.suggestedRole]} decides. Confirm it or pick another Team Role.`
            : 'Pick the Team Role that should decide.'}
        </p>

        <Select
          label="Decider role"
          className="mt-4 max-w-xs"
          options={TeamRole.options.map((r) => ({
            id: r,
            label: `${ROLE_LABEL[r]}${r === request.suggestedRole ? ' (suggested)' : ''}`,
          }))}
          value={role}
          onChange={(r) => changeRole(r as TeamRole)}
        />

        {noCandidates ? (
          <p role="alert" className="mt-4 text-lacquer">
            Nobody but you holds the {ROLE_LABEL[role]} role for this Feature. Pick another role, or
            ask the Team's PO to add one.
          </p>
        ) : candidates.length === 1 ? (
          <p className="mt-4">
            Goes to <span className="font-medium">{candidates[0]?.name}</span>, the only{' '}
            {ROLE_LABEL[role]} for this Feature.
          </p>
        ) : (
          <RadioGroup
            label="Send to"
            className="mt-4"
            name="recipient"
            value={recipient}
            onChange={setRecipient}
          >
            <div className="mt-2 space-y-2">
              <Radio value={ALL}>
                All {candidates.length} {ROLE_LABEL[role]}s. The first to Claim it decides.
              </Radio>
              {candidates.map((p) => (
                <Radio key={p.id} value={p.id}>
                  Only {p.name}
                </Radio>
              ))}
            </div>
          </RadioGroup>
        )}
      </section>

      {defaultWindow && responseWindow && (
        <section aria-labelledby="response-window">
          <h2 id="response-window" className="text-lg font-semibold">
            Response Window
          </h2>
          <p className="mt-1 text-fg-soft">
            How long it may wait for a decision before reminders and escalation start. This Project
            gives a {request.kind === 'BLOCKER' ? 'Blocker' : 'Question'}{' '}
            {responseWindowText(defaultWindow)}. You can shorten it, not lengthen it.
          </p>
          <div className="mt-4 flex max-w-sm gap-3">
            <label className="block w-24">
              <span className="text-sm">Within</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={responseWindow.value}
                onChange={(e) =>
                  setResponseWindow({ ...responseWindow, value: Number(e.target.value) || 1 })
                }
                className={field}
              />
            </label>
            <Select
              label="Unit"
              className="flex-1"
              options={[
                { id: 'WORKING_HOURS', label: 'working hours' },
                { id: 'WORKING_DAYS', label: 'working days' },
              ]}
              value={responseWindow.unit}
              onChange={(unit) =>
                setResponseWindow({ ...responseWindow, unit: unit as ResponseWindowUnit })
              }
            />
          </div>
        </section>
      )}

      {request.withChoices ? (
        <section aria-labelledby="choices">
          <h2 id="choices" className="text-lg font-semibold">
            Choices
          </h2>
          <p className="mt-1 text-fg-soft">
            Drafted by AI. Edit them, or add and remove Choices (two to four).
          </p>
          <ol ref={choiceList} className="mt-4 space-y-4">
            {choices.map((c, i) => {
              const label = LABELS[i] ?? c.label;
              const input = (key: keyof ChoiceDraft, text: string, multiline = false) => {
                const id = `choice-${i}-${key}`;
                return (
                  <div>
                    <label htmlFor={id} className="text-sm text-fg-soft">
                      {text}
                    </label>
                    {multiline ? (
                      <textarea
                        id={id}
                        required
                        rows={2}
                        value={c[key]}
                        onChange={(e) => updateChoice(i, key, e.target.value)}
                        className={field}
                      />
                    ) : (
                      <input
                        id={id}
                        required
                        value={c[key]}
                        onChange={(e) => updateChoice(i, key, e.target.value)}
                        className={field}
                      />
                    )}
                  </div>
                );
              };
              return (
                // Choices have no stable id once edited; the position is their identity here.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={i} data-choice={i} className="rounded-card bg-rail p-5">
                  <fieldset>
                    <legend className="font-semibold">Choice {label}</legend>
                    <div className="mt-3 space-y-3">
                      {input('title', 'Title')}
                      {input('description', 'Description', true)}
                      <div className="grid gap-3 sm:grid-cols-3">
                        {input('impactScope', 'Impact on scope')}
                        {input('impactTime', 'Impact on time')}
                        {input('impactRisk', 'Impact on risk')}
                      </div>
                    </div>
                  </fieldset>
                  <button
                    type="button"
                    onClick={() => removeChoice(i)}
                    disabled={choices.length <= MIN_CHOICES}
                    className="mt-3 text-sm text-lacquer underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-fg-soft disabled:no-underline"
                  >
                    Remove Choice {label}
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            onClick={addChoice}
            disabled={choices.length >= MAX_CHOICES}
            className={`mt-4 ${secondaryButton}`}
          >
            Add a Choice
          </button>
          {choices.length >= MAX_CHOICES && (
            <p className="mt-2 text-sm text-fg-soft">
              Four Choices is the most a request can have.
            </p>
          )}
        </section>
      ) : (
        <p className="text-fg-soft">
          Asked as a plain-text Question. The Decider answers in their own words.
        </p>
      )}

      <div>
        {state.error && (
          <p role="alert" className="mb-4 text-lacquer">
            {state.error}
          </p>
        )}
        <button type="submit" disabled={pending || noCandidates} className={primaryButton}>
          {pending ? 'Sending…' : edited ? 'Send with my edits' : 'Send now'}
        </button>
      </div>
    </form>
  );
}
