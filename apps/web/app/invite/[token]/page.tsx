import type { InvitationPreview } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Notice } from '@/components/bits';
import { field } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { acceptInvitation } from '@/lib/org-actions';

export const metadata = { title: 'Join' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: InvitationPreview;
  try {
    invite = await api<InvitationPreview>(`/invite/${encodeURIComponent(token)}`, {
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    unstable_rethrow(error);
    return (
      <div className="mx-auto max-w-sm pt-8">
        <Notice tone="error">
          {error instanceof ApiError ? error.message : 'This invite link could not be opened.'}
        </Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">Join {invite.organizationName}</h1>
      <p className="mt-1 text-ink-soft">You'll sign in as {invite.email}.</p>
      <div className="mt-8">
        <ActionForm
          action={acceptInvitation.bind(null, token)}
          submitLabel="Join"
          pendingLabel="Joining…"
          className="space-y-4 [&>button]:w-full"
        >
          <label className="block">
            <span className="text-sm">Your name</span>
            <input name="name" required autoComplete="name" className={field} />
          </label>
          <label className="block">
            <span className="text-sm">Choose a password (at least 10 characters)</span>
            <input
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className={field}
            />
          </label>
        </ActionForm>
      </div>
    </div>
  );
}
