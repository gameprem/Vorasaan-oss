const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID. Ids from the browser are checked before they become part of an API path. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** What an Attachment belongs to: a Feature or a Project, named as in the API path. */
export type AttachmentOwner = { kind: 'features' | 'projects'; id: string };

/** True for an owner whose kind is one of the two fixed path segments and whose id is a UUID. */
export function isOwner(value: unknown): value is AttachmentOwner {
  if (!value || typeof value !== 'object') return false;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return (kind === 'features' || kind === 'projects') && isId(id);
}
