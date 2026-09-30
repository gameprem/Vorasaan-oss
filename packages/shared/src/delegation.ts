import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import { TeamRole } from './enums.ts';

const Timestamp = z.iso.datetime({ offset: true });

/**
 * Names a Delegate for a Team Role in a Team over `[startsAt, endsAt)`. `delegatorId`
 * defaults to the caller; only an Org Admin may name someone else.
 */
export const CreateDelegationInput = z
  .object({
    delegatorId: z.uuid().optional(),
    delegateId: z.uuid(),
    role: TeamRole,
    startsAt: Timestamp,
    endsAt: Timestamp,
  })
  .refine((d) => new Date(d.endsAt) > new Date(d.startsAt), {
    message: 'The Delegation must end after it starts',
    path: ['endsAt'],
  });
export type CreateDelegationInput = z.infer<typeof CreateDelegationInput>;

export const DelegationView = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  role: TeamRole,
  delegator: PersonRef,
  delegate: PersonRef,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  createdBy: PersonRef,
  /** Whether it applies right now (startsAt ≤ now < endsAt). */
  active: z.boolean(),
  /** Whether the caller may delete it: its delegator or an Org Admin. */
  canDelete: z.boolean(),
});
export type DelegationView = z.infer<typeof DelegationView>;

/**
 * `GET /me/delegations`: the caller's current and upcoming Delegations, either the ones
 * they gave (`delegator`, the default) or the ones naming them as Delegate (`delegate`).
 * `active=true` keeps only those that apply right now.
 */
export const MyDelegationsQuery = z.object({
  as: z.enum(['delegator', 'delegate']).default('delegator'),
  active: z.enum(['true', 'false']).optional(),
});
export type MyDelegationsQuery = z.infer<typeof MyDelegationsQuery>;
