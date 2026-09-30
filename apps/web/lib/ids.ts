const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID. Ids from the browser are checked before they become part of an API path. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
