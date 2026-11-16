"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  acknowledgeIncident,
  addIncidentEvidence,
  addIncidentNote,
  approveIncidentResolution,
  assignIncident,
  closeIncident,
  createIncident,
  createIncidentFollowUpTask,
  escalateIncident,
  proposeIncidentResolution,
  resolveIncident,
  type AddEvidenceInput,
  type AddIncidentNoteInput,
  type AssignIncidentInput,
  type CreateIncidentFollowUpTaskInput,
  type CreateIncidentInput,
  type EscalateIncidentInput,
  type ProposeResolutionInput,
  type ResolveIncidentInput,
} from "@/server/services/incidents";
import {
  getMyNotificationPreferences,
  listMyNotifications,
  markAllMyNotificationsRead,
  markNotificationRead,
  updateMyNotificationPreference,
  type ListNotificationsInput,
  type UpdatePreferenceInput,
} from "@/server/services/notifications";
import {
  assignTicket,
  closeTicket,
  escalateTicketToTask,
  raiseTicket,
  replyToTicket,
  requestAddressCorrection,
  requestRedelivery,
  resolveTicket,
  type AssignTicketInput,
  type EscalateTicketInput,
  type FollowUpInput,
  type RaiseTicketInput,
  type ReplyTicketInput,
  type ResolveTicketInput,
} from "@/server/services/support-tickets";
import {
  addTaskComment,
  cancelTask,
  createTask,
  reassignTask,
  updateTaskStatus,
  type AddTaskCommentInput,
  type CancelTaskInput,
  type CreateTaskInput,
  type ReassignTaskInput,
  type UpdateTaskStatusInput,
} from "@/server/services/tasks";

/**
 * Server Actions for Phase 8 operations (tasks, incidents, support
 * tickets, notifications) — same contract as the other modules:
 * session actor, P2-3 mustChangePassword gate, service-side
 * permission + scope checks with audited denials.
 */

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

async function withActor<T>(fn: (actor: ActorContext) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor);
    return { success: true, data: await fn(actor) };
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError ||
      error instanceof DomainValidationError
    ) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

function revalidateOps() {
  for (const base of ["/admin", "/warehouse", "/support", "/finance", "/vendor", "/customer", "/rider"]) {
    revalidatePath(base, "layout");
  }
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export async function createIncidentAction(input: CreateIncidentInput) {
  const result = await withActor((actor) => createIncident(actor, input));
  if (result.success) revalidateOps();
  return result;
}

export async function acknowledgeIncidentAction(incidentId: string) {
  const result = await withActor((actor) => acknowledgeIncident(actor, incidentId));
  if (result.success) revalidateOps();
  return result;
}

export async function assignIncidentAction(incidentId: string, input: AssignIncidentInput) {
  const result = await withActor((actor) => assignIncident(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function addIncidentNoteAction(incidentId: string, input: AddIncidentNoteInput) {
  const result = await withActor((actor) => addIncidentNote(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function escalateIncidentAction(incidentId: string, input: EscalateIncidentInput) {
  const result = await withActor((actor) => escalateIncident(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function proposeIncidentResolutionAction(
  incidentId: string,
  input: ProposeResolutionInput,
) {
  const result = await withActor((actor) => proposeIncidentResolution(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function approveIncidentResolutionAction(incidentId: string) {
  const result = await withActor((actor) => approveIncidentResolution(actor, incidentId));
  if (result.success) revalidateOps();
  return result;
}

export async function resolveIncidentAction(incidentId: string, input: ResolveIncidentInput) {
  const result = await withActor((actor) => resolveIncident(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function closeIncidentAction(incidentId: string) {
  const result = await withActor((actor) => closeIncident(actor, incidentId));
  if (result.success) revalidateOps();
  return result;
}

export async function createIncidentFollowUpTaskAction(
  incidentId: string,
  input: CreateIncidentFollowUpTaskInput,
) {
  const result = await withActor((actor) => createIncidentFollowUpTask(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function addIncidentEvidenceAction(incidentId: string, input: AddEvidenceInput) {
  const result = await withActor((actor) => addIncidentEvidence(actor, incidentId, input));
  if (result.success) revalidateOps();
  return result;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTaskAction(input: CreateTaskInput) {
  const result = await withActor((actor) => createTask(actor, input));
  if (result.success) revalidateOps();
  return result;
}

export async function updateTaskStatusAction(taskId: string, input: UpdateTaskStatusInput) {
  const result = await withActor((actor) => updateTaskStatus(actor, taskId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function reassignTaskAction(taskId: string, input: ReassignTaskInput) {
  const result = await withActor((actor) => reassignTask(actor, taskId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function cancelTaskAction(taskId: string, input: CancelTaskInput) {
  const result = await withActor((actor) => cancelTask(actor, taskId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function addTaskCommentAction(taskId: string, input: AddTaskCommentInput) {
  const result = await withActor((actor) => addTaskComment(actor, taskId, input));
  if (result.success) revalidateOps();
  return result;
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

export async function raiseTicketAction(input: RaiseTicketInput) {
  const result = await withActor((actor) => raiseTicket(actor, input));
  if (result.success) revalidateOps();
  return result;
}

export async function replyTicketAction(ticketId: string, input: ReplyTicketInput) {
  const result = await withActor((actor) => replyToTicket(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function assignTicketAction(ticketId: string, input: AssignTicketInput) {
  const result = await withActor((actor) => assignTicket(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function resolveTicketAction(ticketId: string, input: ResolveTicketInput) {
  const result = await withActor((actor) => resolveTicket(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function closeTicketAction(ticketId: string) {
  const result = await withActor((actor) => closeTicket(actor, ticketId));
  if (result.success) revalidateOps();
  return result;
}

export async function requestRedeliveryAction(ticketId: string, input: FollowUpInput) {
  const result = await withActor((actor) => requestRedelivery(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function requestAddressCorrectionAction(ticketId: string, input: FollowUpInput) {
  const result = await withActor((actor) => requestAddressCorrection(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

export async function escalateTicketAction(ticketId: string, input: EscalateTicketInput) {
  const result = await withActor((actor) => escalateTicketToTask(actor, ticketId, input));
  if (result.success) revalidateOps();
  return result;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function listMyNotificationsAction(input: ListNotificationsInput) {
  return withActor((actor) => listMyNotifications(actor, input));
}

export async function markNotificationReadAction(notificationId: string) {
  const result = await withActor((actor) => markNotificationRead(actor, notificationId));
  if (result.success) revalidateOps();
  return result;
}

export async function markAllNotificationsReadAction() {
  const result = await withActor((actor) => markAllMyNotificationsRead(actor));
  if (result.success) revalidateOps();
  return result;
}

export async function getMyNotificationPreferencesAction() {
  return withActor((actor) => getMyNotificationPreferences(actor));
}

export async function updateNotificationPreferenceAction(input: UpdatePreferenceInput) {
  return withActor((actor) => updateMyNotificationPreference(actor, input));
}
