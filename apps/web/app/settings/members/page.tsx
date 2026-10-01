import type { InvitationView, OrgMemberView } from '@vorasaan/shared';
import { headers } from 'next/headers';
import { InviteForm } from '@/components/invite-form';
import { api, currentUser } from '@/lib/api';
import { revokeInvitation } from '@/lib/org-actions';

export const metadata = { title: 'Members' };

export default async function MembersPage() {
  const me = await currentUser();
  const [members, invitations] = await Promise.all([
    api<OrgMemberView[]>('/members'),
    me?.isAdmin ? api<InvitationView[]>('/invitations') : Promise.resolve([]),
  ]);
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;

  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Members</h2>
      <p className="mt-2 text-fg-soft">
        People in the Organization and their Org Role. Team Roles are set per Team.
      </p>
      <ul className="mt-6 rows">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between py-3">
            <span>
              <span className="block font-medium">{m.name}</span>
              <span className="block text-sm text-fg-soft">{m.email}</span>
            </span>
            <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-fg-soft">
              {m.role === 'ADMIN' ? 'Admin' : 'Member'}
            </span>
          </li>
        ))}
      </ul>

      {me?.isAdmin && (
        <div className="mt-12">
          <h3 className="text-lg font-semibold">Invite someone</h3>
          <p className="mt-1 text-fg-soft">
            Vorasaan doesn't send email. Create a link and share it however your team talks.
          </p>
          <div className="mt-4">
            <InviteForm origin={origin} />
          </div>

          {invitations.length > 0 && (
            <>
              <h4 className="mt-10 font-semibold">Waiting to join</h4>
              <ul className="mt-3 rows">
                {invitations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between py-3">
                    <span>
                      <span className="block">{i.email}</span>
                      <span className="block text-sm text-fg-soft">
                        {i.role === 'ADMIN' ? 'Admin' : 'Member'}, link expires{' '}
                        {new Date(i.expiresAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </span>
                    <form action={revokeInvitation.bind(null, i.id)}>
                      <button
                        type="submit"
                        className="rounded-full px-3 py-1.5 text-sm font-semibold text-lacquer hover:bg-lacquer-wash"
                      >
                        Cancel invite
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {!me?.isAdmin && (
        <p className="mt-8 text-sm text-fg-soft">Ask an Admin to invite new people.</p>
      )}
    </section>
  );
}
