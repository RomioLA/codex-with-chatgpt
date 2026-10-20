import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalJson, canonicalSha256 } from "../shared/canonical-json.js";
import type { PersistentTask } from "../tasks/task-types.js";
import { requiredScopesForTaskPlan, TaskSupervisor, TaskSupervisorError } from "../tasks/task-supervisor.js";
import type { Logger } from "../logger/index.js";
import { EXECUTION_TOOL_SCOPES, executionScopeChallenge, executionToolAuth, taskCreateToolAuth } from "./oauth.js";
import type { SnapshotRegistry } from "../workspace/batch.js";

const TASK_RESULT_CHUNK_BYTES = 16 * 1024;
const TASK_API_HTTP_RESPONSE_MAX_BYTES = 64 * 1024;
const TASK_ID = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const CURSOR = z.string().min(1).max(16_384).optional();

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function ok<T extends object>(data: T, summary: string): ToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: data as Record<string, unknown> };
}

function fail(code: string, message: string, challenge?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    isError: true,
    ...(challenge ? { _meta: { "mcp/www_authenticate": [challenge] } } : {}),
  };
}

function requireAuth(
  authInfo: AuthInfo | undefined,
  requiredScope?: string,
  resourceMetadataUri?: string,
): { clientId: string; scopes: readonly string[] } | ToolResult {
  if (!authInfo || typeof authInfo.clientId !== "string" || authInfo.clientId.length === 0) {
    return fail("UNAUTHENTICATED", "This Task operation requires an OAuth-authenticated client.");
  }
  if (requiredScope && !authInfo.scopes.includes(requiredScope)) {
    return fail(
      "INSUFFICIENT_SCOPE",
      `This operation requires the '${requiredScope}' scope.`,
      resourceMetadataUri ? executionScopeChallenge(resourceMetadataUri, requiredScope as never) : undefined,
    );
  }
  return { clientId: authInfo.clientId, scopes: authInfo.scopes };
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && "content" in value);
}

function taskError(error: unknown): ToolResult {
  if (error instanceof TaskSupervisorError) {
    const code = error.code === "TASK_NOT_FOUND"
      ? "TASK_NOT_FOUND_OR_NOT_OWNED"
      : error.code === "TASK_STORE_CORRUPT" || error.code === "TASK_STORE_UNAVAILABLE"
        ? "TASK_STORE_UNAVAILABLE"
        : error.code;
    return fail(code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "IDEMPOTENCY_CONFLICT") return fail("TASK_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different Task plan.");
  if (message === "TASK_STORE_FULL") return fail("TASK_STORE_UNAVAILABLE", "The workspace Task capacity is full.");
  return fail("TASK_INVALID_PLAN", message);
}

function checkRuntime(supervisor: TaskSupervisor): ToolResult | null {
  if (!supervisor.recoveryReady) return fail("TASK_RUNTIME_RECOVERING", "Task recovery is still in progress.");
  if (!supervisor.apiAvailable) return fail("TASK_STORE_UNAVAILABLE", "The Task subsystem is unavailable.");
  return null;
}

function currentStepId(task: PersistentTask): string | null {
  return task.currentStep === null ? null : task.plan.steps[task.currentStep]?.stepId ?? null;
}

function taskStatus(task: PersistentTask, supervisor: TaskSupervisor) {
  const stepId = currentStepId(task);
  const journal = task.dispatchJournal.find((entry) => entry.stepId === stepId);
  const child = journal?.childJobId ? supervisor.executionSupervisor.getForClient(journal.childJobId, task.ownerClientId) : null;
  return {
    task_id: task.taskId,
    state: task.state,
    current_step: task.currentStep,
    current_step_id: stepId,
    completed_steps: task.stepStates.filter((step) => step.state === "succeeded").length,
    total_steps: task.plan.steps.length,
    current_child: child ? {
      job_id: child.jobId,
      state: child.state,
      exit_code: child.exitCode,
      created_at: child.createdAt,
      started_at: child.startedAt,
      finished_at: child.finishedAt,
    } : null,
    waiting_reason: task.waitingReason,
    failure_reason: task.failureReason,
    timestamps: {
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      deadline_at: task.deadlineAt,
    },
  };
}

function hasTaskScopes(task: PersistentTask, scopes: readonly string[]): boolean {
  return task.authBinding.requiredScopes.every((scope) => scopes.includes(scope));
}

function utf8Page(value: string, offset: number, maxBytes: number): { text: string; nextOffset: number; eof: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) throw new RangeError("Invalid Task result cursor position");
  let end = Math.min(bytes.byteLength, offset + maxBytes);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === offset && end < bytes.byteLength) {
    end = Math.min(bytes.byteLength, offset + Math.max(4, maxBytes));
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  return { text: bytes.subarray(offset, end).toString("utf8"), nextOffset: end, eof: end >= bytes.byteLength };
}

function wireResponseBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "task-api", result }), "utf8");
}

export function registerTaskTools(server: McpServer, input: {
  supervisor: TaskSupervisor;
  snapshotRegistry: SnapshotRegistry;
  workspaceId: string;
  logger: Logger;
  oauthResourceMetadataUri?: string;
}): void {
  const { supervisor, snapshotRegistry, workspaceId, logger, oauthResourceMetadataUri } = input;

  server.registerTool("task_create", {
    ...taskCreateToolAuth(),
    title: "Create persistent C2C Task",
    description:
      "Create an immutable, finite Task plan. Scope is checked from every step before persistence; execution steps require the existing Full Access authorization. " +
      "Tasks never add steps or run an autonomous model loop. Use task_status, task_result, task_output, task_list, or task_cancel for recovery.",
    inputSchema: {
      plan: z.unknown(),
      idempotency_key: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]{16,128}$/),
    },
    outputSchema: {
      task_id: z.string(),
      state: z.string(),
      plan_hash: z.string(),
      duplicate: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    try {
      const missingScope = requiredScopesForTaskPlan(args.plan).find((scope) => !auth.scopes.includes(scope));
      if (missingScope) {
        return fail(
          "INSUFFICIENT_SCOPE",
          `This Task plan requires the '${missingScope}' scope.`,
          oauthResourceMetadataUri ? executionScopeChallenge(oauthResourceMetadataUri, missingScope as never) : undefined,
        );
      }
      const created = supervisor.create({
        ownerClientId: auth.clientId,
        idempotencyKey: args.idempotency_key,
        scopes: auth.scopes as never,
        plan: args.plan,
      });
      if (created.task.state === "QUEUED" || created.task.state === "RUNNING") {
        void supervisor.run(created.task.taskId, auth.clientId).catch((error: unknown) => {
          logger.warn("Persistent Task execution stopped", {
            taskId: created.task.taskId,
            code: error instanceof TaskSupervisorError ? error.code : "TASK_RUN_FAILED",
          });
        });
      }
      return ok({
        task_id: created.task.taskId,
        state: created.task.state,
        plan_hash: created.task.planHash,
        duplicate: created.duplicate,
      }, "Persistent Task created or recovered by idempotency key.");
    } catch (error) {
      return taskError(error);
    }
  });

  server.registerTool("task_status", {
    ...executionToolAuth("execution_status"),
    title: "Persistent Task status",
    description: "Read the persisted state and current child summary for a Task owned by this OAuth client.",
    inputSchema: { task_id: TASK_ID },
    outputSchema: {
      task_id: z.string(), state: z.string(), current_step: z.number().int().nullable(), current_step_id: z.string().nullable(),
      completed_steps: z.number().int().nonnegative(), total_steps: z.number().int().nonnegative(),
      current_child: z.object({ job_id: z.string(), state: z.string(), exit_code: z.number().int().nullable(),
        created_at: z.string(), started_at: z.string().nullable(), finished_at: z.string().nullable() }).nullable(),
      waiting_reason: z.string().nullable(), failure_reason: z.string().nullable(),
      timestamps: z.object({ created_at: z.string(), updated_at: z.string(), deadline_at: z.string() }),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo, EXECUTION_TOOL_SCOPES.execution_status, oauthResourceMetadataUri);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    try {
      const task = supervisor.get(args.task_id, auth.clientId);
      if (!task) return fail("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client.");
      if (!hasTaskScopes(task, auth.scopes)) return fail("INSUFFICIENT_SCOPE", "The current token lacks a scope required by this Task.");
      return ok(taskStatus(task, supervisor), "Task status read from persistent state.");
    } catch (error) { return taskError(error); }
  });

  server.registerTool("task_list", {
    ...executionToolAuth("execution_list"),
    title: "List persistent C2C Tasks",
    description: "List a bounded snapshot of recent Tasks owned by this OAuth client in this workspace. The cursor is owner-, workspace-, scope-, and query-bound.",
    inputSchema: { limit: z.number().int().min(1).max(20).default(20), cursor: CURSOR },
    outputSchema: { tasks: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().nullable(), snapshot: z.literal(true) },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo, EXECUTION_TOOL_SCOPES.execution_list, oauthResourceMetadataUri);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    const ownerId = auth.clientId;
    const scopes = [...auth.scopes].sort();
    const requestHash = canonicalSha256({ api: "task_list", limit: args.limit, scopes });
    const binding = { workspaceId, ownerId, requestHash };
    try {
      if (args.cursor) {
        const resolved = snapshotRegistry.resolve<Array<Record<string, unknown>>>(args.cursor, binding);
        const page = resolved.payload.slice(resolved.position, resolved.position + args.limit);
        const position = resolved.position + page.length;
        const nextCursor = position < resolved.payload.length
          ? snapshotRegistry.issueCursor(resolved.snapshotId, position)
          : null;
        return ok({ tasks: page, next_cursor: nextCursor, snapshot: true as const }, `Returned ${page.length} Task records from a stable snapshot.`);
      }
      const tasks = supervisor.list(ownerId).filter((task) => hasTaskScopes(task, scopes)).map((task) => taskStatus(task, supervisor));
      const firstPage = tasks.slice(0, args.limit);
      if (tasks.length <= args.limit) {
        return ok({ tasks: firstPage, next_cursor: null, snapshot: true as const }, `Returned ${firstPage.length} Task records.`);
      }
      const created = snapshotRegistry.createWithSnapshotId({ ...binding, payload: tasks }, args.limit);
      return ok({ tasks: firstPage, next_cursor: created.cursor, snapshot: true as const }, `Returned ${firstPage.length} Task records. More are available.`);
    } catch (error) {
      return error instanceof Error && "code" in error
        ? fail(String((error as { code?: unknown }).code ?? "TASK_CURSOR_INVALID"), error.message)
        : taskError(error);
    }
  });

  server.registerTool("task_result", {
    ...executionToolAuth("execution_status"),
    title: "Read persistent Task results",
    description:
      "Read checkpoint results without copying child stdout or stderr. The canonical JSON result is returned in bounded UTF-8 chunks; concatenate result_json_chunk values in cursor order to reconstruct the snapshot.",
    inputSchema: { task_id: TASK_ID, cursor: CURSOR },
    outputSchema: {
      task_id: z.string(), state: z.string(), result_hash: z.string(), result_json_chunk: z.string(),
      offset: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative(), eof: z.boolean(), next_cursor: z.string().nullable(),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo, EXECUTION_TOOL_SCOPES.execution_status, oauthResourceMetadataUri);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    const task = supervisor.get(args.task_id, auth.clientId);
    if (!task) return fail("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client.");
    if (!hasTaskScopes(task, auth.scopes)) return fail("INSUFFICIENT_SCOPE", "The current token lacks a scope required by this Task.");
    const requestHash = canonicalSha256({ api: "task_result", taskId: task.taskId });
    const binding = { workspaceId, ownerId: auth.clientId, requestHash };
    try {
      let serialized: string;
      let snapshotId: string | null = null;
      let offset: number;
      if (args.cursor) {
        const resolved = snapshotRegistry.resolve<string>(args.cursor, binding);
        serialized = resolved.payload;
        snapshotId = resolved.snapshotId;
        offset = resolved.position;
      } else {
        serialized = canonicalJson({ task_id: task.taskId, state: task.state, checkpoints: task.checkpoints });
        offset = 0;
      }
      const page = utf8Page(serialized, offset, TASK_RESULT_CHUNK_BYTES);
      let nextCursor: string | null = null;
      if (!page.eof) {
        if (snapshotId === null) {
          const created = snapshotRegistry.createWithSnapshotId({ ...binding, payload: serialized }, page.nextOffset);
          snapshotId = created.snapshotId;
          nextCursor = created.cursor;
        } else {
          nextCursor = snapshotRegistry.issueCursor(snapshotId, page.nextOffset);
        }
      }
      const snapshot = JSON.parse(serialized) as { task_id: string; state: string };
      const data = {
        task_id: snapshot.task_id,
        state: snapshot.state,
        result_hash: canonicalSha256(serialized),
        result_json_chunk: page.text,
        offset,
        next_offset: page.nextOffset,
        eof: page.eof,
        next_cursor: nextCursor,
      };
      const response = ok(data, `Task result snapshot bytes ${offset}–${page.nextOffset}${page.eof ? " (complete)" : " (continued)"}.`);
      if (wireResponseBytes(response) > TASK_API_HTTP_RESPONSE_MAX_BYTES) {
        return fail("TASK_RESULT_TOO_LARGE", "Task result page exceeded the HTTP response budget.");
      }
      return response;
    } catch (error) {
      return error instanceof Error && "code" in error
        ? fail(String((error as { code?: unknown }).code ?? "TASK_CURSOR_INVALID"), error.message)
        : taskError(error);
    }
  });

  server.registerTool("task_output", {
    ...executionToolAuth("execution_job_output"),
    title: "Read persistent Task child output",
    description: "Read sanitized segmented stdout or stderr for a Task execution step through ExecutionSupervisor/JobStore with byte offsets and UTF-8 boundaries.",
    inputSchema: {
      task_id: TASK_ID,
      step_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
      stream: z.enum(["stdout", "stderr"]),
      offset: z.number().int().nonnegative().default(0),
      max_bytes: z.number().int().min(1).max(64 * 1024).default(16 * 1024),
    },
    outputSchema: {
      task_id: z.string(), step_id: z.string(), job_id: z.string(), stream: z.enum(["stdout", "stderr"]),
      offset: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative(),
      oldest_available_offset: z.number().int().nonnegative(), eof: z.boolean(), truncated: z.boolean(), text: z.string(),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo, EXECUTION_TOOL_SCOPES.execution_job_output, oauthResourceMetadataUri);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    const task = supervisor.get(args.task_id, auth.clientId);
    if (!task) return fail("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client.");
    if (!hasTaskScopes(task, auth.scopes)) return fail("INSUFFICIENT_SCOPE", "The current token lacks a scope required by this Task.");
    let requestedBytes = args.max_bytes;
    try {
      for (;;) {
        const output = supervisor.readOutput(args.task_id, auth.clientId, args.step_id, args.stream, args.offset, requestedBytes);
        const data = {
          task_id: output.taskId,
          step_id: output.stepId,
          job_id: output.jobId,
          stream: output.stream,
          offset: output.offset,
          next_offset: output.nextOffset,
          oldest_available_offset: output.oldestAvailableOffset,
          eof: output.eof,
          truncated: output.truncated,
          text: output.text,
        };
        const response = ok(data, `Returned ${Buffer.byteLength(output.text, "utf8")} sanitized output bytes.`);
        if (wireResponseBytes(response) <= TASK_API_HTTP_RESPONSE_MAX_BYTES) return response;
        if (requestedBytes <= 1) return fail("TASK_OUTPUT_RESTRICTED", "Task output page could not fit the HTTP response budget.");
        requestedBytes = Math.max(1, Math.floor(requestedBytes / 2));
      }
    } catch (error) { return taskError(error); }
  });

  server.registerTool("task_cancel", {
    ...executionToolAuth("execution_cancel"),
    title: "Cancel persistent Task",
    description: "Persist CANCELLING first. The response reports CANCELLED only after any active execution child is confirmed terminal; ambiguous child termination is reported as INTERRUPTED.",
    inputSchema: { task_id: TASK_ID },
    outputSchema: {
      task_id: z.string(), state: z.string(), current_step: z.number().int().nullable(), completed_steps: z.number().int(), total_steps: z.number().int(),
      waiting_reason: z.string().nullable(), failure_reason: z.string().nullable(), updated_at: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const auth = requireAuth(extra.authInfo, EXECUTION_TOOL_SCOPES.execution_cancel, oauthResourceMetadataUri);
    if (isToolResult(auth)) return auth;
    const unavailable = checkRuntime(supervisor);
    if (unavailable) return unavailable;
    const existing = supervisor.get(args.task_id, auth.clientId);
    if (!existing) return fail("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client.");
    if (!hasTaskScopes(existing, auth.scopes)) return fail("INSUFFICIENT_SCOPE", "The current token lacks a scope required by this Task.");
    try {
      const task = await supervisor.cancel(args.task_id, auth.clientId);
      return ok({
        task_id: task.taskId,
        state: task.state,
        current_step: task.currentStep,
        completed_steps: task.stepStates.filter((step) => step.state === "succeeded").length,
        total_steps: task.plan.steps.length,
        waiting_reason: task.waitingReason,
        failure_reason: task.failureReason,
        updated_at: task.updatedAt,
      }, `Task cancellation result: ${task.state}.`);
    } catch (error) { return taskError(error); }
  });
}
