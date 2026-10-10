'use server';

import {
  type AgentSkillUpdateResult,
  type AgentSkillView,
  InstallAgentSkillInput,
  SetAgentSkillProjectsInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Settings → Agent Skills (ticket 0078). The API checks that the caller is an Admin; every
// input is parsed with the shared contract first.

export type SkillActionResult = { error?: string; message?: string };

const PATH = '/settings/agent-skills';
const BASE = '/settings/agent-skills';

async function attempt(run: () => Promise<string | undefined>): Promise<SkillActionResult> {
  let message: string | undefined;
  try {
    message = await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(PATH);
  return { message };
}

export async function installAgentSkill(input: {
  url: string;
  subpath?: string;
}): Promise<SkillActionResult> {
  const parsed = InstallAgentSkillInput.safeParse({
    url: input.url,
    ...(input.subpath?.trim() ? { subpath: input.subpath } : {}),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the URL' };
  return attempt(async () => {
    const skill = await api<AgentSkillView>(BASE, { method: 'POST', body: parsed.data });
    return `Installed ${skill.name}. Review it, then approve it before the AI can use it.`;
  });
}

export async function updateAgentSkill(id: string): Promise<SkillActionResult> {
  if (!isId(id)) return { error: 'Not found' };
  return attempt(async () => {
    const result = await api<AgentSkillUpdateResult>(`${BASE}/${id}/update`, { method: 'POST' });
    return result.upToDate
      ? `${result.skill.name} is up to date.`
      : `Fetched version ${result.skill.pending?.number} of ${result.skill.name}. Review its changes, then approve or discard it.`;
  });
}

export async function approveAgentSkillVersion(
  id: string,
  number: number,
): Promise<SkillActionResult> {
  if (!isId(id) || !Number.isInteger(number)) return { error: 'Not found' };
  return attempt(async () => {
    const skill = await api<AgentSkillView>(`${BASE}/${id}/versions/${number}/approve`, {
      method: 'POST',
    });
    return `Approved version ${number} of ${skill.name}.`;
  });
}

export async function declineAgentSkillVersion(
  id: string,
  number: number,
): Promise<SkillActionResult> {
  if (!isId(id) || !Number.isInteger(number)) return { error: 'Not found' };
  return attempt(async () => {
    const skill = await api<AgentSkillView>(`${BASE}/${id}/versions/${number}/decline`, {
      method: 'POST',
    });
    return `Discarded version ${number} of ${skill.name}.`;
  });
}

export async function setAgentSkillProjects(
  id: string,
  projectIds: string[],
): Promise<SkillActionResult> {
  if (!isId(id)) return { error: 'Not found' };
  const parsed = SetAgentSkillProjectsInput.safeParse({ projectIds });
  if (!parsed.success) return { error: 'Choose Projects from the list' };
  return attempt(async () => {
    const skill = await api<AgentSkillView>(`${BASE}/${id}/projects`, {
      method: 'PUT',
      body: parsed.data,
    });
    const n = skill.projectIds.length;
    return `${skill.name} is enabled in ${n} Project${n === 1 ? '' : 's'}.`;
  });
}

export async function uninstallAgentSkill(id: string, name: string): Promise<SkillActionResult> {
  if (!isId(id)) return { error: 'Not found' };
  return attempt(async () => {
    await api(`${BASE}/${id}`, { method: 'DELETE' });
    return `Uninstalled ${name}.`;
  });
}
