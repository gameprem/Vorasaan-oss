import type { AccessTokenView } from '@vorasaan/shared';
import { relativeTime } from '@/components/bits';
import { CreateTokenForm } from '@/components/create-token-form';
import { api } from '@/lib/api';
import { revokeAccessToken } from '@/lib/auth-actions';

export const metadata = { title: 'Access tokens' };

export default async function TokensPage() {
  const tokens = await api<AccessTokenView[]>('/me/tokens');
  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Access tokens</h1>
      <p className="mt-2 text-ink-soft">
        Tokens let the <code className="font-mono text-ink">vorasaan</code> CLI act as you. Create
        one per device, then run <code className="font-mono text-ink">vorasaan login</code> and
        paste it.
      </p>

      <CreateTokenForm activeIds={tokens.map((t) => t.id)} />

      {tokens.length > 0 && (
        <ul className="mt-10 divide-y divide-rule border-y border-rule">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-4 py-3">
              <span className="flex-1">
                <span className="block font-medium">{t.name}</span>
                <span className="block text-sm text-ink-soft">
                  Created {relativeTime(t.createdAt)}.{' '}
                  {t.lastUsedAt ? `Last used ${relativeTime(t.lastUsedAt)}.` : 'Never used.'}
                </span>
              </span>
              <form action={revokeAccessToken.bind(null, t.id)}>
                <button
                  type="submit"
                  className="rounded-lg border border-rule px-3 py-1.5 text-sm text-seal hover:bg-seal-wash"
                >
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
