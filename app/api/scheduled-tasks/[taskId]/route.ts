export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readLimitedJson } from "@/lib/apiSecurity";
import { scheduledTaskErrorResponse, scheduledTaskUser } from "@/lib/scheduledTaskRoute";
import {
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  scheduledTaskUpdateSchema,
  updateScheduledTask,
} from "@/lib/scheduledTaskService";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/scheduled-tasks/[taskId]">
) {
  try {
    const { taskId } = await context.params;
    if (!TASK_ID.test(taskId)) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    const user = await scheduledTaskUser(request, true);
    if ("response" in user) return user.response;
    const body = await readLimitedJson(request, 16 * 1024, scheduledTaskUpdateSchema);
    const task = "action" in body
      ? body.action === "pause"
        ? await pauseScheduledTask(user.userId, taskId, body.expectedRevision)
        : await resumeScheduledTask(user.userId, taskId, body.expectedRevision, body.confirmCredits)
      : await updateScheduledTask(user.userId, taskId, body);
    return NextResponse.json({ task });
  } catch (error) {
    return scheduledTaskErrorResponse(error, "scheduled_task_update_failed");
  }
}

/** Removes the task and its run history. The conversation its answers went to stays. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/scheduled-tasks/[taskId]">
) {
  try {
    const { taskId } = await context.params;
    if (!TASK_ID.test(taskId)) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    const user = await scheduledTaskUser(request, true);
    if ("response" in user) return user.response;
    await deleteScheduledTask(user.userId, taskId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return scheduledTaskErrorResponse(error, "scheduled_task_delete_failed");
  }
}
