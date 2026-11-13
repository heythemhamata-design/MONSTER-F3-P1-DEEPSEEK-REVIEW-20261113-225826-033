import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getPostgresPool } from "../lib/db/postgres";
import { executeTool } from "../lib/ai/tool-executor";
import { executeWorkspaceTool, type WorkspaceToolExecution } from "../lib/workspace/tools";

loadEnvConfig(process.cwd());

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key]),
  ).join(",") + "}";
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeWorkspaceExecution(
  taskId: string,
  operationIndex: number,
  _tool: string,
  args: Record<string, unknown>,
): WorkspaceToolExecution {
  return {
    taskId,
    runId: randomUUID(),
    correlationId: `cross-tool-replay:${taskId}`,
    agentId: "editor",
    operationIndex,
    // Unified logical identity: intentionally excludes tool name.
    operationKey: hash(`${taskId}:side-effect:${operationIndex}`),
    argumentsHash: hash(stableJson(args)),
  };
}

function makeMemoryTaskExecution(taskId: string, operationIndex: number) {
  const taskIdentity = {
    taskId,
    runId: randomUUID(),
    correlationId: `cross-tool-replay:${taskId}`,
  };
  return {
    taskIdentity,
    effectIdentity: { ...taskIdentity, operationIndex },
  };
}

async function insertStartMarker(
  pool: ReturnType<typeof getPostgresPool>,
  taskId: string,
  operationIndex: number,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const operationKey = hash(`${taskId}:side-effect:${operationIndex}`);
  await pool.query(
    `INSERT INTO public.task_events
      (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'tool.execution_started', 'info', false, $6::jsonb)`,
    [
      taskId,
      randomUUID(),
      `cross-tool-replay:${taskId}`,
      tool === "memory_save" ? "memory" : "editor",
      tool,
      JSON.stringify({
        tool,
        operationIndex,
        operationKey,
        argumentsHash: hash(stableJson(args)),
      }),
    ],
  );
}

async function main(): Promise<void> {
  const pool = getPostgresPool();
  const token = randomUUID();
  const relativeRoot = `cross_tool_identity_${token}`;
  const absoluteRoot = path.resolve(process.cwd(), "workspace", relativeRoot);
  const baseOperationIndex = Date.now() % 900_000 + 100_000;
  const operationIndexes = [0, 1, 2, 3, 4].map((offset) => baseOperationIndex + offset);
  let taskId: string | null = null;
  let memoryTitle: string | null = null;
  let cleanupComplete = false;

  console.log(`Cross-tool side-effect identity marker: ${token}`);
  console.log("This test uses one existing terminal task only as an event anchor; its task state is never changed.");

  try {
    const anchor = await pool.query<{ id: string }>(
      `SELECT id::text AS id
       FROM public.tasks
       WHERE status IN ('completed', 'failed', 'cancelled')
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    assert.equal(anchor.rowCount, 1, "A terminal task is required as an isolated event anchor.");
    taskId = anchor.rows[0].id;

    const collisions = await pool.query(
      `SELECT 1 FROM public.task_events
       WHERE task_id = $1::uuid
         AND details->>'operationIndex' = ANY($2::text[])
         AND event_type IN ('tool.execution_started', 'tool.execution_succeeded')
       LIMIT 1`,
      [taskId, operationIndexes.map(String)],
    );
    assert.equal(collisions.rowCount, 0, "Generated operation indexes must not collide with existing receipts.");

    await mkdir(absoluteRoot, { recursive: true });

    // A) Workspace write success followed by a different workspace tool at the same index.
    const writeArgs = { path: `${relativeRoot}/write-then-append.txt`, content: `WRITE_${token}` };
    const write = await executeWorkspaceTool(
      "workspace_write_file",
      JSON.stringify(writeArgs),
      makeWorkspaceExecution(taskId, operationIndexes[0], "workspace_write_file", writeArgs),
    );
    assert.equal(write?.status, "succeeded");

    const appendArgs = { path: writeArgs.path, content: `_MUST_NOT_APPEND_${token}` };
    const changedToolReplay = await executeWorkspaceTool(
      "workspace_append_file",
      JSON.stringify(appendArgs),
      makeWorkspaceExecution(taskId, operationIndexes[0], "workspace_append_file", appendArgs),
    );
    assert.equal(changedToolReplay?.ok, false);
    assert.equal(changedToolReplay?.status, "outcome_unknown");
    assert.equal(await readFile(path.join(absoluteRoot, "write-then-append.txt"), "utf8"), writeArgs.content);
    console.log("PASS: a successful workspace_write_file receipt blocked workspace_append_file at the same operation index.");

    // B) Workspace start marker followed by a Memory save at the same operation index.
    const workspaceStartArgs = { path: `${relativeRoot}/workspace-started.txt`, content: `NOT_WRITTEN_${token}` };
    await insertStartMarker(pool, taskId, operationIndexes[1], "workspace_write_file", workspaceStartArgs);
    const memoryArgsAfterWorkspace = {
      title: `Cross-tool blocked memory ${token}`,
      content: `Must not be saved because workspace already reserved this step ${token}`,
      category: "phase2-3-test",
      tags: ["temporary", "cross-tool"],
    };
    const memoryAfterWorkspace = await executeTool(
      "memory_save",
      JSON.stringify(memoryArgsAfterWorkspace),
      {
        kind: "agent",
        agentId: "memory",
        allowedTools: ["memory_save"],
        ...makeMemoryTaskExecution(taskId, operationIndexes[1]),
      },
    );
    assert.equal(memoryAfterWorkspace.ok, false);
    assert.equal(memoryAfterWorkspace.status, "outcome_unknown");
    const blockedMemoryCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.memories WHERE title = $1 AND category = $2",
      [memoryArgsAfterWorkspace.title, memoryArgsAfterWorkspace.category],
    );
    assert.equal(blockedMemoryCount.rows[0].count, 0);
    console.log("PASS: a workspace start marker blocked memory_save at the same operation index; no memory row was created.");

    // C) Memory success followed by a Workspace write at the same operation index.
    memoryTitle = `Cross-tool committed memory ${token}`;
    const committedMemoryArgs = {
      title: memoryTitle,
      content: `Committed once by memory_save ${token}`,
      category: "phase2-3-test",
      tags: ["temporary", "cross-tool"],
    };
    const memorySuccess = await executeTool(
      "memory_save",
      JSON.stringify(committedMemoryArgs),
      {
        kind: "agent",
        agentId: "memory",
        allowedTools: ["memory_save"],
        ...makeMemoryTaskExecution(taskId, operationIndexes[2]),
      },
    );
    assert.equal(memorySuccess.ok, true);
    assert.equal(memorySuccess.status, "succeeded");

    const workspaceAfterMemoryArgs = { path: `${relativeRoot}/must-not-write-after-memory.txt`, content: `BLOCKED_${token}` };
    const workspaceAfterMemory = await executeWorkspaceTool(
      "workspace_write_file",
      JSON.stringify(workspaceAfterMemoryArgs),
      makeWorkspaceExecution(taskId, operationIndexes[2], "workspace_write_file", workspaceAfterMemoryArgs),
    );
    assert.equal(workspaceAfterMemory?.ok, false);
    assert.equal(workspaceAfterMemory?.status, "outcome_unknown");
    await assert.rejects(readFile(path.join(absoluteRoot, "must-not-write-after-memory.txt"), "utf8"));
    console.log("PASS: a committed memory_save receipt blocked workspace_write_file at the same operation index.");

    // D) A workspace-only start marker blocks a different workspace tool after a simulated crash.
    const interruptedWriteArgs = { path: `${relativeRoot}/interrupted-write.txt`, content: `NO_REPLAY_${token}` };
    await insertStartMarker(pool, taskId, operationIndexes[3], "workspace_write_file", interruptedWriteArgs);
    const interruptedAppendArgs = { path: interruptedWriteArgs.path, content: `APPEND_MUST_NOT_RUN_${token}` };
    const interruptedCrossTool = await executeWorkspaceTool(
      "workspace_append_file",
      JSON.stringify(interruptedAppendArgs),
      makeWorkspaceExecution(taskId, operationIndexes[3], "workspace_append_file", interruptedAppendArgs),
    );
    assert.equal(interruptedCrossTool?.ok, false);
    assert.equal(interruptedCrossTool?.status, "outcome_unknown");
    await assert.rejects(readFile(path.join(absoluteRoot, "interrupted-write.txt"), "utf8"));
    console.log("PASS: a start-without-success marker blocked a different workspace tool after simulated interruption.");

    // E) Concurrent cross-tool calls share one lock; exactly one logical operation may win.
    const concurrentIndex = operationIndexes[4];
    const concurrentWorkspaceArgs = { path: `${relativeRoot}/concurrent.txt`, content: `WORKSPACE_${token}` };
    const concurrentMemoryTitle = `Concurrent cross-tool memory ${token}`;
    const concurrentMemoryArgs = {
      title: concurrentMemoryTitle,
      content: `Concurrent memory candidate ${token}`,
      category: "phase2-3-test",
      tags: ["temporary", "concurrent"],
    };
    const [concurrentWorkspace, concurrentMemory] = await Promise.all([
      executeWorkspaceTool(
        "workspace_write_file",
        JSON.stringify(concurrentWorkspaceArgs),
        makeWorkspaceExecution(taskId, concurrentIndex, "workspace_write_file", concurrentWorkspaceArgs),
      ),
      executeTool(
        "memory_save",
        JSON.stringify(concurrentMemoryArgs),
        {
          kind: "agent",
          agentId: "memory",
          allowedTools: ["memory_save"],
          ...makeMemoryTaskExecution(taskId, concurrentIndex),
        },
      ),
    ]);
    const concurrentStatuses = [concurrentWorkspace?.status, concurrentMemory.status];
    assert.equal(concurrentStatuses.filter((status) => status === "succeeded").length, 1);
    assert.equal(concurrentStatuses.filter((status) => status === "outcome_unknown").length, 1);
    console.log("PASS: concurrent Workspace/Memory operations sharing one task step produced exactly one success and one blocked outcome.");

    const receiptCounts = await pool.query<{ operation_index: string; event_type: string; total: string }>(
      `SELECT details->>'operationIndex' AS operation_index, event_type, COUNT(*)::text AS total
       FROM public.task_events
       WHERE task_id = $1::uuid
         AND details->>'operationIndex' = ANY($2::text[])
         AND event_type IN ('tool.execution_started', 'tool.execution_succeeded')
       GROUP BY details->>'operationIndex', event_type
       ORDER BY operation_index, event_type`,
      [taskId, operationIndexes.map(String)],
    );
    console.log(`Receipt groups recorded: ${receiptCounts.rows.length}`);
    console.log("RESULT: PASS — cross-tool identity, legacy-index lookup, Memory/Workspace mutual exclusion and concurrent replay protection verified.");
  } finally {
    let eventCleanup = false;
    let fileCleanup = false;
    let memoryCleanup = false;
    try {
      if (taskId) {
        await pool.query(
          `DELETE FROM public.task_events
           WHERE task_id = $1::uuid
             AND details->>'operationIndex' = ANY($2::text[])
             AND event_type IN ('tool.execution_started', 'tool.execution_succeeded')`,
          [taskId, operationIndexes.map(String)],
        );
      }
      eventCleanup = true;
    } catch (error) {
      console.error(`EVENT_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await rm(absoluteRoot, { recursive: true, force: true });
      fileCleanup = true;
    } catch (error) {
      console.error(`FILE_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (memoryTitle) {
        await pool.query(
          "DELETE FROM public.memories WHERE title = ANY($1::text[]) AND category = $2",
          [[memoryTitle, `Concurrent cross-tool memory ${token}`], "phase2-3-test"],
        );
      }
      // Also remove the deliberately blocked candidate if an implementation bug ever inserted it.
      await pool.query(
        "DELETE FROM public.memories WHERE title = $1 AND category = $2",
        [`Cross-tool blocked memory ${token}`, "phase2-3-test"],
      );
      memoryCleanup = true;
    } catch (error) {
      console.error(`MEMORY_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanupComplete = eventCleanup && fileCleanup && memoryCleanup;
    await pool.end();
    console.log(`CLEANUP_STATUS: ${cleanupComplete ? "complete" : "incomplete"}`);
  }
}

main().catch((error) => {
  console.error(`CROSS-TOOL IDENTITY TEST FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
