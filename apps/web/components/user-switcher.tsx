import { switchUser } from '@/lib/actions';
import type { DevUser } from '@/lib/api';

/** DEV ONLY: pick who you are until real sign-in exists. */
export function UserSwitcher({ users, currentId }: { users: DevUser[]; currentId?: string }) {
  if (users.length === 0) {
    return <span className="text-sm text-ink-soft">No users. Run bun run db:seed.</span>;
  }
  return (
    <form action={switchUser} className="flex items-center gap-2 text-sm">
      <label htmlFor="userId" className="text-ink-soft">
        Viewing as
      </label>
      <select
        key={currentId ?? 'nobody'}
        id="userId"
        name="userId"
        defaultValue={currentId ?? ''}
        className="rounded-md border border-rule bg-sheet px-2 py-1 text-ink"
      >
        <option value="">Nobody</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md border border-rule px-2 py-1 text-ink-soft hover:text-ink"
      >
        Switch
      </button>
      <span
        className="rounded bg-seal-wash px-1.5 py-0.5 text-xs text-seal"
        title="Development identity switcher, not real sign-in"
      >
        dev
      </span>
    </form>
  );
}
