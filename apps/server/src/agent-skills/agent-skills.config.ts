import type { AgentSkillLimits } from '@vorasaan/shared';

const KiB = 1024;
const MiB = 1024 * KiB;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * The size limits of an Agent Skill (ticket 0078), read on every install or update so an
 * operator (or a test) can change them without a restart:
 * - `VORASAAN_AGENT_SKILL_MAX_BYTES`: every kept file of one Skill together (2 MiB);
 * - `VORASAAN_AGENT_SKILL_MAX_FILE_BYTES`: one kept file (256 KiB);
 * - `VORASAAN_AGENT_SKILL_MAX_FILES`: kept files in one Skill (200);
 * - `VORASAAN_AGENT_SKILL_MAX_ARCHIVE_BYTES`: a zip, uploaded or downloaded from GitHub (20 MiB).
 * Files left out (scripts, images) count only towards the archive's size.
 */
export function agentSkillLimits(
  env: Record<string, string | undefined> = process.env,
): AgentSkillLimits {
  return {
    maxSkillBytes: positiveInt(env.VORASAAN_AGENT_SKILL_MAX_BYTES, 2 * MiB),
    maxFileBytes: positiveInt(env.VORASAAN_AGENT_SKILL_MAX_FILE_BYTES, 256 * KiB),
    maxFiles: positiveInt(env.VORASAAN_AGENT_SKILL_MAX_FILES, 200),
    maxArchiveBytes: positiveInt(env.VORASAAN_AGENT_SKILL_MAX_ARCHIVE_BYTES, 20 * MiB),
  };
}
