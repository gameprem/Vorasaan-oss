import type { RecordedModel } from '@vorasaan/shared';

/**
 * "Drafted with Best": the model that drafted a proposal in a Conversation (ticket 0054),
 * as it was named then. Nothing when it wasn't drafted there.
 */
export function DraftedWith({ model, what }: { model: RecordedModel | null; what?: string }) {
  if (!model) return null;
  return (
    <span className="block text-xs text-fg-soft">
      {what ? `${what} drafted` : 'Drafted'} with {model.displayName ?? model.modelId}
    </span>
  );
}
