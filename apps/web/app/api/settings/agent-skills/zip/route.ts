import { forwardUpload, maxSkillZipBytes } from '@/lib/attachment-upload';

// Installs an Agent Skill from an uploaded zip (Settings → Agent Skills, ticket 0078). The API
// checks that the caller is an Admin; the session token never reaches the browser.
export async function POST(request: Request) {
  return forwardUpload(request, '/settings/agent-skills/zip', maxSkillZipBytes());
}
