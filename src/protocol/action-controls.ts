import { z } from "zod";
import { IsoTimestamp, Uuid } from "./primitives.js";

export const ControlledOperation = z.enum([
  "messages.send",
  "tasks.create",
  "tasks.update",
  "tasks.delete",
  "facts.upsert",
  "facts.delete",
  "documents.create",
  "documents.update",
  "documents.delete",
]);

export const QuarantineObjectType = z.enum(["fact", "document"]);

export const WorkspaceActionControls = z.object({
  enabled: z.boolean(),
  confirmation_operations: z.array(ControlledOperation),
  quarantine_enabled: z.boolean(),
  quarantine_object_types: z.array(QuarantineObjectType),
});

export const UpdateWorkspaceActionControlsRequest = WorkspaceActionControls;

export const ActionControlsResponse = z.object({
  controls: WorkspaceActionControls,
  operation_catalog: z.array(ControlledOperation),
  quarantine_object_catalog: z.array(QuarantineObjectType),
});

export const UpdatedActionControlsResponse = z.object({
  controls: WorkspaceActionControls,
});

export const ConfirmationRecord = z.object({
  id: Uuid,
  workspace_id: Uuid,
  requested_by: Uuid,
  operation: ControlledOperation,
  target_type: z.string(),
  target_id: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected", "executed", "expired"]),
  reviewed_by: Uuid.nullable(),
  review_note: z.string().nullable(),
  expires_at: IsoTimestamp,
  created_at: IsoTimestamp,
  reviewed_at: IsoTimestamp.nullable(),
  executed_at: IsoTimestamp.nullable(),
});

export const ListConfirmationsResponse = z.object({
  confirmations: z.array(ConfirmationRecord),
});

export const ConfirmationResponse = z.object({
  confirmation: ConfirmationRecord,
});

export const ReviewConfirmationRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

export const QuarantineRecord = z.object({
  id: Uuid,
  workspace_id: Uuid,
  object_type: QuarantineObjectType,
  object_id: z.string(),
  reason: z.string(),
  status: z.enum(["active", "released"]),
  reported_by: Uuid,
  reviewed_by: Uuid.nullable(),
  review_note: z.string().nullable(),
  created_at: IsoTimestamp,
  reviewed_at: IsoTimestamp.nullable(),
});

export const ReportQuarantineRequest = z.object({
  object_type: QuarantineObjectType,
  object_id: z.string().min(1).max(500),
  reason: z.string().min(1).max(2000),
});

export const ReviewQuarantineRequest = z.object({
  decision: z.enum(["release", "retain"]),
  note: z.string().max(1000).optional(),
});

export const ListQuarantinesResponse = z.object({
  quarantines: z.array(QuarantineRecord),
});

export const QuarantineResponse = z.object({
  quarantine: QuarantineRecord,
});

export type ControlledOperationT = z.infer<typeof ControlledOperation>;
export type QuarantineObjectTypeT = z.infer<typeof QuarantineObjectType>;
