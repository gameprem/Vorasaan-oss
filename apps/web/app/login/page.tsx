import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { currentUser } from '@/lib/api';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await currentUser()) redirect('/inbox');
  return (
    <div className="mx-auto max-w-sm pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to Vorasaan</h1>
      <p className="mt-1 text-ink-soft">Decisions waiting for you are one step away.</p>
      <LoginForm />
    </div>
  );
}
