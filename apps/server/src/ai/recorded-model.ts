import type { RecordedModel } from '@vorasaan/shared';

// The model that wrote a reply or drafted a proposal (ticket 0054) is stored as three
// columns: the Approved Model's id (a plain id, so the record outlives the model),
// its display name and the provider's model id, as they were then.

/** The stored columns, on a ConversationMessage, a Spec Proposal or a Brief Proposal. */
export type RecordedModelColumns = {
  approvedModelId: string | null;
  modelDisplayName: string | null;
  modelName: string | null;
};

export function toRecordedModelColumns(model: RecordedModel | null | undefined) {
  return {
    approvedModelId: model?.approvedModelId ?? null,
    modelDisplayName: model?.displayName ?? null,
    modelName: model?.modelId ?? null,
  } satisfies RecordedModelColumns;
}

/** The record, or null when nothing was recorded (written by a person, or before 0054). */
export function fromRecordedModelColumns(
  row: RecordedModelColumns | null | undefined,
): RecordedModel | null {
  if (!row?.modelName) return null;
  return {
    approvedModelId: row.approvedModelId,
    displayName: row.modelDisplayName,
    modelId: row.modelName,
  };
}

/** How a person recognizes it: the display name, or the env model's "provider/model". */
export function modelLabel(model: RecordedModel): string {
  return model.displayName ?? model.modelId;
}
