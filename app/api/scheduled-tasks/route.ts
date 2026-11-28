export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readLimitedJson } from "@/lib/apiSecurity";
import { SCHEDULED_TASK_LIMITS, scheduledTaskEmailEnabled } from "@/lib/scheduledTaskCore";
import { scheduledTaskErrorResponse, scheduledTaskUser } from "@/lib/scheduledTaskRoute";
import {
  createScheduledTask,
  listScheduledTasks,
  scheduledTaskAvailability,
  scheduledTaskInputSchema,
} from "@/lib/scheduledTaskService";

/**
 * The account's scheduled tasks. Listing and deleting work whatever the
 * switch says -- a person can always see and remove what they saved -- while
 * creating, editing and resuming need `feature.scheduledTasksEnabled` and a
 * Pro or Max plan.
 */
export async function GET(request: Request) {
  try {
    const user = await scheduledTaskUser(request, false);
    if ("response" in user) return user.response;
    const [availability, tasks] = await Promise.all([
      scheduledTaskAvailability(user.userId),
      listScheduledTasks(user.userId),
    ]);
    return NextResponse.json({
      ...availability,
      // Whether this deployment sends result emails at all; the per-task switch
      // is shown only when it does.
      emailNotices: scheduledTaskEmailEnabled(process.env),
      limits: {
        maxActiveTasks: SCHEDULED_TASK_LIMITS.maxActiveTasks,
        maxTasks: SCHEDULED_TASK_LIMITS.maxTasks,
        titleCharacters: SCHEDULED_TASK_LIMITS.titleCharacters,
        promptCharacters: SCHEDULED_TASK_LIMITS.promptCharacters,
      },
      tasks,
    });
  } catch (error) {
    return scheduledTaskErrorResponse(error, "scheduled_tasks_list_failed");
  }
}

export async function POST(request: Request) {
  try {
    const user = await scheduledTaskUser(request, true);
    if ("response" in user) return user.response;
    const input = await readLimitedJson(request, 16 * 1024, scheduledTaskInputSchema);
    const task = await createScheduledTask(user.userId, input);
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return scheduledTaskErrorResponse(error, "scheduled_task_create_failed");
  }
}
