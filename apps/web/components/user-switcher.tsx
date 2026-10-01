import { switchUser } from '@/lib/actions';
import type { DevUser } from '@/lib/api';

/** DEV ONLY: pick who you are until real sign-in exists. */
export function UserSwitcher({ users, currentId }: { users: DevUser[]; currentId?: string }) {
  if (users.length === 0) {
    return <span className="text-sm text-fg-soft">No users. Run bun run db:seed.</span>;
  }
  return (
    <form action={switchUser} className="grid gap-1 text-sm">
      <span className="flex items-center gap-2">
        <label htmlFor="userId" className="text-fg-soft">
          Viewing as
        </label>
        <span
          className="rounded-full bg-lacquer-wash px-2 py-0.5 text-xs font-semibold text-lacquer"
          title="Development identity switcher, not real sign-in"
        >
          dev
        </span>
      </span>
      <span className="flex items-center gap-1">
        <select
          key={currentId ?? 'nobody'}
          id="userId"
          name="userId"
          defaultValue={currentId ?? ''}
          className="min-w-0 flex-1 rounded-full bg-surface px-3 py-1.5 text-fg"
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
          className="rounded-full px-3 py-1.5 font-semibold text-ink hover:bg-ink-wash"
        >
          Switch
        </button>
      </span>
    </form>
  );
}
