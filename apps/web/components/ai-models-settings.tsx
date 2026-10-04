'use client';

import {
  type AiProvider,
  type AiProviderView,
  type AiSettingsView,
  type AiTask,
  type AiTestResult,
  type ApprovedModelSettingsView,
  CONTEXT_WINDOW_LIMITS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_NAMES,
  knownContextWindow,
} from '@vorasaan/shared';
import { useCallback, useState, useTransition } from 'react';
import {
  type ActionResult,
  createAiProvider,
  createApprovedModel,
  deleteAiProvider,
  deleteApprovedModel,
  listOpenRouterModels,
  setAiTaskModels,
  testApprovedModel,
  updateAiProvider,
  updateApprovedModel,
} from '@/lib/ai-settings-actions';
import { OpenRouterModelPicker } from './openrouter-model-picker';
import { PROVIDERS, ProviderKindPicker } from './provider-fields';
import { field, primaryButton, secondaryButton } from './ui';
import { Checkbox } from './ui/checkbox';
import { Select } from './ui/select';

// Settings → AI models (ADR 0010): the providers (with their keys), the Approved
// Models people may use with one default, and the model of each AI task.

const TASK_LABEL: Record<AiTask, { label: string; hint: string }> = {
  CHOICES: { label: 'Choices', hint: 'Options suggested for a Decision Request' },
  SPEC_PROPOSAL: {
    label: 'Spec Proposals',
    hint: 'Spec changes after a Decision, or a first Spec',
  },
  SUMMARIES: { label: 'Summaries', hint: 'Attachment and Conversation summaries' },
  GRILLING: { label: 'Grilling', hint: 'Questions, and the Brief Proposal from the answers' },
  FEATURE_SUGGESTIONS: { label: 'Feature Suggestions', hint: 'Features proposed from the Brief' },
  FIT_CHECK: { label: 'Fit check', hint: 'A new Feature against the Feature Guidelines' },
  CHAT: { label: 'Chat', hint: 'Replies in Conversations' },
  PROMPT_PROPOSALS: {
    label: 'Prompt proposals',
    hint: 'Reading feedback on a prompt and proposing a Prompt Version',
  },
};

const kindLabel = (kind: AiProvider) => PROVIDERS.find((p) => p.value === kind)?.label ?? kind;

/** Runs a server action and keeps its error (or a short confirmation) for display. */
function useAction() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const run = (action: () => Promise<ActionResult>, done?: string, onOk?: () => void) =>
    start(async () => {
      const result = await action();
      if (result.error) setMessage({ ok: false, text: result.error });
      else {
        setMessage(done ? { ok: true, text: done } : undefined);
        onOk?.();
      }
    });
  return { pending, message, run, clear: () => setMessage(undefined) };
}

function Status({ message }: { message?: { ok: boolean; text: string } }) {
  if (!message) return null;
  return (
    <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-jade' : 'text-lacquer'}>
      {message.text}
    </p>
  );
}

export function AiModelsSettings({ settings }: { settings: AiSettingsView }) {
  return (
    <div className="space-y-12">
      <ProvidersSection providers={settings.providers} />
      <ModelsSection providers={settings.providers} models={settings.models} />
      {/* Starts over when the models change (one removed, renamed or added), not on its own save. */}
      <TasksSection
        key={JSON.stringify(settings.models.map((m) => [m.id, m.displayName, m.isDefault]))}
        settings={settings}
      />
    </div>
  );
}

// ─── Providers ──────────────────────────────────────────────────────────────

function ProvidersSection({ providers }: { providers: AiProviderView[] }) {
  const [adding, setAdding] = useState(providers.length === 0);
  return (
    <section aria-labelledby="ai-providers">
      <h3 id="ai-providers" className="text-lg font-semibold">
        Providers
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        The services your models run on, each with its own key. Keys are stored encrypted and never
        shown again.
      </p>
      <ul className="mt-4 rows">
        {providers.length === 0 && (
          <li className="px-4 py-3 text-fg-soft">No provider connected yet.</li>
        )}
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} />
        ))}
      </ul>
      {adding ? (
        <NewProviderForm onDone={() => setAdding(false)} canCancel={providers.length > 0} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`mt-4 ${secondaryButton}`}>
          Connect a provider
        </button>
      )}
    </section>
  );
}

function ProviderRow({ provider }: { provider: AiProviderView }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    apiKey: '',
  });
  const { pending, message, run } = useAction();
  const custom = provider.kind === 'OPENAI_COMPATIBLE';

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{provider.name}</span>
        <span className="text-sm text-fg-soft">
          {kindLabel(provider.kind)}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''} · key ends in{' '}
          {provider.apiKeyHint.replace('…', '')} · {provider.modelCount}{' '}
          {provider.modelCount === 1 ? 'model' : 'models'}
        </span>
        <span className="ml-auto flex gap-3 text-sm">
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="text-fg-soft hover:text-fg"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (confirm(`Remove the provider "${provider.name}"?`)) {
                run(() => deleteAiProvider(provider.id));
              }
            }}
            className="text-fg-soft hover:text-lacquer disabled:opacity-40"
          >
            Remove
          </button>
        </span>
      </div>
      {editing && (
        <form
          className="mt-3 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                updateAiProvider(provider.id, {
                  name: draft.name.trim(),
                  ...(custom ? { baseUrl: draft.baseUrl.trim() } : {}),
                  ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
                }),
              undefined,
              () => {
                setEditing(false);
                setDraft((d) => ({ ...d, apiKey: '' }));
              },
            );
          }}
        >
          <label className="block">
            <span className="text-sm">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={field}
            />
          </label>
          {custom && (
            <label className="block">
              <span className="text-sm">Base URL</span>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                className={field}
              />
            </label>
          )}
          <label className="block">
            <span className="text-sm">
              New key <span className="text-fg-soft">(leave blank to keep the saved one)</span>
            </span>
            <input
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              className={field}
            />
          </label>
          <div>
            <button type="submit" disabled={pending} className={primaryButton}>
              {pending ? 'Saving…' : 'Save provider'}
            </button>
          </div>
        </form>
      )}
      <div className="mt-2">
        <Status message={message} />
      </div>
    </li>
  );
}

function NewProviderForm({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const [kind, setKind] = useState<AiProvider>('ANTHROPIC');
  const [draft, setDraft] = useState({
    name: DEFAULT_PROVIDER_NAMES.ANTHROPIC,
    baseUrl: '',
    apiKey: '',
  });
  const { pending, message, run } = useAction();
  const current = PROVIDERS.find((p) => p.value === kind) ?? PROVIDERS[0];

  return (
    <form
      aria-label="Connect a provider"
      className="mt-4 rounded-card bg-rail p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const name = draft.name.trim();
        const apiKey = draft.apiKey.trim();
        run(
          () =>
            createAiProvider(
              kind === 'OPENAI_COMPATIBLE'
                ? { kind, name, apiKey, baseUrl: draft.baseUrl.trim() }
                : { kind, name, apiKey },
            ),
          undefined,
          onDone,
        );
      }}
    >
      <ProviderKindPicker
        label="Kind"
        name="provider-kind"
        value={kind}
        onChange={(next) => {
          setKind(next);
          setDraft({ ...draft, name: DEFAULT_PROVIDER_NAMES[next] });
        }}
      />
      <label className="mt-4 block">
        <span className="text-sm">Name</span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className={field}
        />
      </label>
      {kind === 'OPENAI_COMPATIBLE' && (
        <label className="mt-4 block">
          <span className="text-sm">Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder="http://localhost:20128/v1"
            className={field}
          />
        </label>
      )}
      <label className="mt-4 block">
        <span className="text-sm">{current?.keyLabel}</span>
        <input
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          className={field}
        />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Connecting…' : 'Connect'}
        </button>
        {canCancel && (
          <button type="button" onClick={onDone} className={secondaryButton}>
            Cancel
          </button>
        )}
        <Status message={message} />
      </div>
    </form>
  );
}

// ─── Approved Models ────────────────────────────────────────────────────────

type ModelDraft = {
  providerId: string;
  modelId: string;
  displayName: string;
  note: string;
  /** Tokens, as typed; empty lets the server prefill it (ticket 0060). */
  contextWindow: string;
  isDefault: boolean;
};

/** The window as typed ("200,000", "200_000" or "200000"), or undefined when left empty. */
function windowOf(text: string): number | undefined {
  const cleaned = text.replace(/[\s,_]/g, '');
  return cleaned ? Number(cleaned) : undefined;
}

/** "200k tokens", "1M tokens", "8,192 tokens". */
function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M tokens`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k tokens`;
  return `${tokens.toLocaleString('en')} tokens`;
}

function ModelsSection({
  providers,
  models,
}: {
  providers: AiProviderView[];
  models: ApprovedModelSettingsView[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-labelledby="approved-models">
      <h3 id="approved-models" className="text-lg font-semibold">
        Approved Models
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        The only models people can use, under names they recognize. The default is used wherever no
        other model is set.
      </p>
      <ul className="mt-4 rows">
        {models.length === 0 && (
          <li className="px-4 py-3 text-fg-soft">
            No Approved Model yet. Until there is one, the server's environment chooses the model.
          </li>
        )}
        {models.map((m) => (
          <ModelRow key={m.id} model={m} providers={providers} />
        ))}
      </ul>
      {providers.length === 0 ? (
        <p className="mt-4 text-sm text-fg-soft">Connect a provider to add models.</p>
      ) : adding ? (
        <NewModelForm
          providers={providers}
          first={models.length === 0}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`mt-4 ${secondaryButton}`}>
          Add a model
        </button>
      )}
    </section>
  );
}

function ModelRow({
  model,
  providers,
}: {
  model: ApprovedModelSettingsView;
  providers: AiProviderView[];
}) {
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<AiTestResult>();
  const [testing, startTest] = useTransition();
  const { pending, message, run } = useAction();

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{model.displayName}</span>
        {model.isDefault && (
          <span className="rounded-full bg-surface font-semibold px-2 py-0.5 text-xs text-fg-soft">
            Default
          </span>
        )}
        <span className="text-sm text-fg-soft">
          {model.modelId} · {model.providerName} · {formatWindow(model.contextWindow)}
        </span>
        <span className="ml-auto flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            disabled={testing}
            onClick={() => startTest(async () => setTest(await testApprovedModel(model.id)))}
            className="text-fg-soft hover:text-fg disabled:opacity-40"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          {!model.isDefault && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => updateApprovedModel(model.id, { isDefault: true }))}
              className="text-fg-soft hover:text-fg disabled:opacity-40"
            >
              Make default
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="text-fg-soft hover:text-fg"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          {!model.isDefault && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (
                  confirm(`Remove "${model.displayName}"? Tasks using it switch to the default.`)
                ) {
                  run(() => deleteApprovedModel(model.id));
                }
              }}
              className="text-fg-soft hover:text-lacquer disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {model.note && <p className="mt-1 text-sm text-fg-soft">{model.note}</p>}
      {test && (
        <p role="status" className={`mt-1 text-sm ${test.ok ? 'text-jade' : 'text-lacquer'}`}>
          {test.ok
            ? `${test.message} (${((test.latencyMs ?? 0) / 1000).toFixed(1)}s)`
            : test.message}
        </p>
      )}
      {editing && (
        <ModelForm
          providers={providers}
          initial={{
            providerId: model.providerId,
            modelId: model.modelId,
            displayName: model.displayName,
            note: model.note ?? '',
            contextWindow: String(model.contextWindow),
            isDefault: model.isDefault,
          }}
          showDefault={false}
          submitLabel="Save model"
          pending={pending}
          onSubmit={(d) =>
            run(
              () =>
                updateApprovedModel(model.id, {
                  providerId: d.providerId,
                  modelId: d.modelId.trim(),
                  displayName: d.displayName.trim(),
                  note: d.note.trim() || null,
                  contextWindow: windowOf(d.contextWindow),
                }),
              undefined,
              () => setEditing(false),
            )
          }
        />
      )}
      <div className="mt-2">
        <Status message={message} />
      </div>
    </li>
  );
}

function NewModelForm({
  providers,
  first,
  onDone,
}: {
  providers: AiProviderView[];
  first: boolean;
  onDone: () => void;
}) {
  const { pending, message, run } = useAction();
  const provider = providers[0];
  return (
    <div className="mt-4 rounded-card bg-rail p-4">
      <ModelForm
        providers={providers}
        initial={{
          providerId: provider?.id ?? '',
          modelId: provider ? DEFAULT_MODELS[provider.kind] : '',
          displayName: '',
          note: '',
          contextWindow: String(
            (provider && knownContextWindow(DEFAULT_MODELS[provider.kind])) ?? '',
          ),
          isDefault: first,
        }}
        showDefault={!first}
        submitLabel="Add model"
        pending={pending}
        onCancel={onDone}
        onSubmit={(d) =>
          run(
            () =>
              createApprovedModel({
                providerId: d.providerId,
                modelId: d.modelId.trim(),
                displayName: d.displayName.trim(),
                note: d.note.trim() || null,
                contextWindow: windowOf(d.contextWindow),
                isDefault: d.isDefault,
              }),
            undefined,
            onDone,
          )
        }
      />
      <div className="mt-2">
        <Status message={message} />
      </div>
    </div>
  );
}

function ModelForm({
  providers,
  initial,
  showDefault,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  providers: AiProviderView[];
  initial: ModelDraft;
  showDefault: boolean;
  submitLabel: string;
  pending: boolean;
  onSubmit: (draft: ModelDraft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  /** Until the Admin types a window, it follows the model id (a known model's window). */
  const [windowTyped, setWindowTyped] = useState(false);
  const kind = providers.find((p) => p.id === draft.providerId)?.kind;
  const loadModels = useCallback(() => listOpenRouterModels(draft.providerId), [draft.providerId]);
  return (
    <form
      aria-label={submitLabel}
      className="mt-3 grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
      }}
    >
      <label className="block">
        <span className="text-sm">Display name</span>
        <input
          value={draft.displayName}
          maxLength={60}
          onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          placeholder="Fast, Best, Local (no data leaves)…"
          className={field}
        />
      </label>
      <Select
        label="Provider"
        options={providers.map((p) => ({
          id: p.id,
          label: `${p.name} (${kindLabel(p.kind)})`,
        }))}
        value={draft.providerId}
        onChange={(providerId) => setDraft({ ...draft, providerId })}
      />
      {kind === 'OPENROUTER' && (
        <div className="sm:col-span-2">
          {/* OpenRouter's list (ticket 0064): a pick fills the id and its window. */}
          <OpenRouterModelPicker
            key={draft.providerId}
            load={loadModels}
            selectedId={draft.modelId}
            inputClass={field}
            onPick={(m) => {
              if (m.contextWindow) setWindowTyped(false);
              setDraft({
                ...draft,
                modelId: m.id,
                displayName: draft.displayName || m.name.slice(0, 60),
                contextWindow: m.contextWindow
                  ? String(m.contextWindow)
                  : windowTyped
                    ? draft.contextWindow
                    : '',
              });
            }}
          />
        </div>
      )}
      <label className="block">
        <span className="text-sm">Model id</span>
        <input
          value={draft.modelId}
          onChange={(e) => {
            const modelId = e.target.value;
            const known = knownContextWindow(modelId);
            setDraft({
              ...draft,
              modelId,
              ...(windowTyped ? {} : { contextWindow: known ? String(known) : '' }),
            });
          }}
          placeholder="The model name the provider expects"
          className={field}
        />
      </label>
      <label className="block">
        <span className="text-sm">Note (optional)</span>
        <input
          value={draft.note}
          maxLength={300}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          placeholder="For quick questions"
          className={field}
        />
      </label>
      <label className="block">
        <span className="text-sm">Context window (tokens)</span>
        <input
          value={draft.contextWindow}
          inputMode="numeric"
          onChange={(e) => {
            setWindowTyped(true);
            setDraft({ ...draft, contextWindow: e.target.value });
          }}
          placeholder="Left empty: the server's default"
          aria-describedby="context-window-hint"
          className={field}
        />
        <span id="context-window-hint" className="mt-1 block text-xs text-fg-soft">
          How much one AI call can hold. Every task's context is a share of it. At least{' '}
          {CONTEXT_WINDOW_LIMITS.min.toLocaleString('en')}.
        </span>
      </label>
      {showDefault && (
        <Checkbox
          className="text-sm sm:col-span-2"
          isSelected={draft.isDefault}
          onChange={(isDefault) => setDraft({ ...draft, isDefault })}
        >
          Make it the default
        </Checkbox>
      )}
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ─── Model per task ─────────────────────────────────────────────────────────

function TasksSection({ settings }: { settings: AiSettingsView }) {
  const initial = Object.fromEntries(
    settings.tasks.map((t) => [t.task, t.approvedModelId ?? '']),
  ) as Record<AiTask, string>;
  const [choice, setChoice] = useState(initial);
  const { pending, message, run, clear } = useAction();
  const fallback = settings.models.find((m) => m.isDefault);

  return (
    <section aria-labelledby="ai-tasks">
      <h3 id="ai-tasks" className="text-lg font-semibold">
        Model per task
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        Which Approved Model each kind of AI work uses. Changes apply to the next request.
      </p>
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () =>
              setAiTaskModels({
                tasks: Object.fromEntries(
                  settings.tasks.map((t) => [t.task, choice[t.task] || null]),
                ),
              }),
            'Saved.',
          );
        }}
      >
        <div className="rows">
          {settings.tasks.map((t) => (
            <div
              key={t.task}
              className="grid items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_16rem]"
            >
              <span>
                <span className="block font-medium">{TASK_LABEL[t.task].label}</span>
                <span className="block text-sm text-fg-soft">{TASK_LABEL[t.task].hint}</span>
                {t.envOverrides.length > 0 && (
                  <span className="block text-sm text-lacquer">
                    Set on the server by {t.envOverrides.join(', ')}, which wins over this setting.
                  </span>
                )}
              </span>
              <Select
                aria-label={TASK_LABEL[t.task].label}
                isDisabled={settings.models.length === 0}
                options={[
                  { id: '', label: `Default${fallback ? ` (${fallback.displayName})` : ''}` },
                  ...settings.models.map((m) => ({
                    id: m.id,
                    label: m.displayName,
                    description: m.modelId,
                  })),
                ]}
                value={choice[t.task]}
                onChange={(id) => {
                  clear();
                  setChoice({ ...choice, [t.task]: id });
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button
            type="submit"
            disabled={pending || settings.models.length === 0}
            className={primaryButton}
          >
            {pending ? 'Saving…' : 'Save tasks'}
          </button>
          <Status message={message} />
        </div>
      </form>
    </section>
  );
}
