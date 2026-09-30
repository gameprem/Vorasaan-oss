import { z } from 'zod';

export const LoginInput = z.object({
  email: z.email({ message: 'Enter a valid email' }),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const UserRef = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
export type UserRef = z.infer<typeof UserRef>;

export const MeView = UserRef.extend({ isAdmin: z.boolean() });
export type MeView = z.infer<typeof MeView>;

export const LoginResult = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  user: UserRef,
});
export type LoginResult = z.infer<typeof LoginResult>;

export const CreateAccessTokenInput = z.object({
  name: z.string().trim().min(1, 'Name the token, e.g. "Laptop CLI"').max(100),
});
export type CreateAccessTokenInput = z.infer<typeof CreateAccessTokenInput>;

export const AccessTokenView = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type AccessTokenView = z.infer<typeof AccessTokenView>;

/** Returned once, at creation. The token itself is never shown again. */
export const CreatedAccessToken = AccessTokenView.extend({ token: z.string() });
export type CreatedAccessToken = z.infer<typeof CreatedAccessToken>;

/** Minimum length for new passwords. */
export const Password = z.string().min(10, 'Use at least 10 characters');
