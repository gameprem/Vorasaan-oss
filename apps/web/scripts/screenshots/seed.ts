// Writes the story through the real API, as the people in it: setup, invitations, Teams,
// Features, Specs, Decision Requests, Decisions, Conversations and a Grilling. The AI
// output comes from the scripted model (model.ts), through the server's real AI path.

import type {
  ConversationView,
  CreatedAccessToken,
  CreatedInvitation,
  DecideResult,
  DecisionRequestView,
  GrillingView,
  LoginResult,
  ProjectView,
  TeamRole,
} from '@vorasaan/shared';
import { SETUP_TOKEN_HEADER } from '@vorasaan/shared';
import type { ScriptedModel } from './model';
import {
  BEAM_ERRORS,
  BRIEF,
  type ConversationStory,
  FEATURES,
  GRILLING,
  HERO,
  ORGANIZATION,
  PEOPLE,
  type PersonKey,
  PIM_PROJECT,
  PIM_SPEC_CHANGE,
  REQUESTS,
  TEAMS,
} from './story';

export type Seeded = {
  projectId: string;
  features: Record<string, string>;
  conversations: { hero: string; specChange: string; grilling: string };
  /** A token per person; the CLI user gets a real access token instead (accessToken). */
  tokens: Record<PersonKey, string>;
  userIds: Record<PersonKey, string>;
};

type Api = <T>(
  as: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<T>;

export function apiClient(baseUrl: string): Api {
  return async (token, method, path, body, headers) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : undefined) as never;
  };
}

export async function seedStory(
  api: Api,
  model: ScriptedModel,
  password: string,
  setupToken: string,
) {
  const tokens = {} as Record<PersonKey, string>;
  const userIds = {} as Record<PersonKey, string>;

  // The first Admin sets the Organization up, with the AI gateway as its provider.
  const setup = await api<LoginResult>(
    null,
    'POST',
    '/setup',
    {
      organizationName: ORGANIZATION,
      admin: { name: PEOPLE.pim.name, email: PEOPLE.pim.email, password },
      ai: {
        provider: 'OPENAI_COMPATIBLE',
        model: 'qwen3-235b-a22b-instruct',
        baseUrl: model.url,
        apiKey: 'sk-gw-7Hq2mZ9vR4tL8nXcP3',
      },
    },
    { [SETUP_TOKEN_HEADER]: setupToken },
  );
  tokens.pim = setup.token;
  userIds.pim = setup.user.id;
  const pim = setup.token;

  // Settings → AI models: "Best" (the default) and "Fast" on the gateway.
  type Settings = { providers: { id: string }[]; models: { id: string }[] };
  const ai = await api<Settings>(pim, 'GET', '/settings/ai');
  const providerId = ai.providers[0]?.id as string;
  const bestId = ai.models[0]?.id as string;
  await api(pim, 'PATCH', `/settings/ai/providers/${providerId}`, { name: 'AI gateway' });
  await api(pim, 'PATCH', `/settings/ai/models/${bestId}`, {
    displayName: 'Best',
    note: 'Specs, Choices and hard calls',
  });
  const fast = await api<{ id: string }>(pim, 'POST', '/settings/ai/models', {
    providerId,
    modelId: 'qwen3-30b-a3b-instruct',
    displayName: 'Fast',
    note: 'Quick answers and summaries',
  });
  await api(pim, 'PUT', '/settings/ai/tasks', {
    tasks: { SUMMARIES: fast.id, GRILLING: fast.id },
  });

  // Everyone else joins through an invitation link.
  for (const key of Object.keys(PEOPLE) as PersonKey[]) {
    if (key === 'pim') continue;
    const who = PEOPLE[key];
    const invite = await api<CreatedInvitation>(pim, 'POST', '/invitations', {
      email: who.email,
      role: 'MEMBER',
    });
    const joined = await api<LoginResult>(null, 'POST', `/invite/${invite.token}`, {
      name: who.name,
      password,
    });
    tokens[key] = joined.token;
    userIds[key] = joined.user.id;
  }

  const project = await api<ProjectView>(pim, 'POST', '/projects', {
    name: 'Mobile Banking',
    jiraKey: 'MB',
  });
  await api(pim, 'POST', `/projects/${project.id}/brief-versions`, {
    markdown: BRIEF,
    summary: 'First Brief, from the 2026 planning deck',
    baseVersion: 0,
  });

  const teamIds: Record<string, string> = {};
  for (const [name, members] of Object.entries(TEAMS)) {
    const team = await api<{ id: string }>(pim, 'POST', `/projects/${project.id}/teams`, { name });
    teamIds[name] = team.id;
    for (const [key, roles] of Object.entries(members)) {
      await api(pim, 'PUT', `/teams/${team.id}/members/${userIds[key as PersonKey]}`, { roles });
    }
  }

  const features: Record<string, string> = {};
  for (const f of FEATURES) {
    const created = await api<{ id: string }>(pim, 'POST', `/teams/${teamIds[f.team]}/features`, {
      title: f.title,
      description: f.description,
      jiraIssueKey: f.jiraIssueKey,
    });
    features[f.key] = created.id;
    const owners = Object.entries(f.owners).flatMap(([key, roles]) =>
      (roles as TeamRole[]).map((role) => ({ userId: userIds[key as PersonKey], role })),
    );
    await api(pim, 'PUT', `/features/${created.id}/role-owners`, { owners });
    // The Spec's first version is written by a PO of the Feature.
    const po = f.owners.pim ? pim : tokens.mint;
    await api(po, 'POST', `/features/${created.id}/spec-versions`, {
      markdown: f.spec,
      summary: 'First version, from the kickoff',
      baseVersion: 0,
    });
  }

  // Decision Requests: drafted with AI Choices, sent, and some decided.
  for (const r of REQUESTS) {
    const raiser = tokens[r.raiser];
    const draft = await api<DecisionRequestView>(raiser, 'POST', '/decision-requests', {
      featureId: features[r.feature],
      kind: r.kind,
      title: r.title,
      description: r.description,
      withChoices: r.withChoices ?? true,
    });
    await api(raiser, 'POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: r.deciderRole,
      recipients: 'ALL',
    });
    if (!r.decide) continue;
    const decider = tokens[r.decide.by];
    await api(decider, 'POST', `/decision-requests/${draft.id}/claim`);
    const choice = draft.choices.find((c) => c.label === r.decide?.label);
    const decided = await api<DecideResult>(
      decider,
      'POST',
      `/decision-requests/${draft.id}/decision`,
      {
        choiceId: choice?.id,
        rationale: r.decide.rationale,
      },
    );
    if (r.decide.approveSpec) {
      await api(decider, 'POST', `/spec-proposals/${decided.proposal.id}/approve`);
    }
  }

  // Conversations, each turn answered by the scripted model.
  const converse = async (story: ConversationStory) => {
    const token = tokens[story.owner];
    const scope =
      'feature' in story.scope
        ? { kind: 'FEATURE', featureId: features[story.scope.feature] }
        : { kind: 'PROJECT', projectId: project.id };
    let id = '';
    for (const turn of story.turns) {
      model.chat(...turn.replies);
      const view = id
        ? await api<{ conversation: ConversationView }>(
            token,
            'POST',
            `/conversations/${id}/messages`,
            {
              content: turn.message,
            },
          ).then((r) => r.conversation)
        : await api<ConversationView>(token, 'POST', '/conversations', {
            scope,
            content: turn.message,
          });
      id = view.id;
      if (model.pending()) throw new Error(`A reply was left unused in "${turn.message}"`);
    }
    return id;
  };
  await converse(PIM_PROJECT);
  const specChange = await converse(PIM_SPEC_CHANGE);
  await converse(BEAM_ERRORS);
  const hero = await converse(HERO);

  // Grilling: Pim starts it; the Business round goes to the POs, Pim and Mint.
  const grillingRun = await api<GrillingView>(pim, 'POST', `/projects/${project.id}/grillings`);
  const open = (token: string) =>
    api<ConversationView>(token, 'POST', `/grillings/${grillingRun.id}/conversation`);
  const say = (token: string, id: string, content: string) =>
    api(token, 'POST', `/conversations/${id}/messages`, { content });
  const pimsGrilling = (await open(pim)).id;
  const mintsGrilling = (await open(tokens.mint)).id;
  for (const answer of GRILLING.pim) await say(pim, pimsGrilling, answer);
  // Pim's answer moved Mint on to question 2; her answer reaches Pim's Conversation too.
  await say(tokens.mint, mintsGrilling, GRILLING.mint);

  return {
    projectId: project.id,
    features,
    conversations: { hero, specChange, grilling: pimsGrilling },
    tokens,
    userIds,
  } satisfies Seeded;
}

/** A real access token, created the way Settings → Access tokens creates one. */
export async function accessToken(api: Api, token: string, name: string): Promise<string> {
  return (await api<CreatedAccessToken>(token, 'POST', '/me/tokens', { name })).token;
}
