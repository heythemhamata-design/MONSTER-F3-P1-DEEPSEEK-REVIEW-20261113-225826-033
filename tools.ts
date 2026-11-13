import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  appendFile,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { getPostgresPool } from "@/lib/db/postgres";

const MAX_FILE_BYTES = 1_000_000;
const BLOCKED_PATH_SEGMENTS = new Set([
  ".system",
  ".git",
  ".next",
  "node_modules",
  ".cache",
]);

function isBlockedPathSegment(segment: string): boolean {
  return BLOCKED_PATH_SEGMENTS.has(segment.toLowerCase()) || /^\.env(?:\.|$)/i.test(segment);
}

type WorkspaceResult = {
  ok: boolean;
  tool: string;
  status?: "succeeded" | "failed" | "outcome_unknown" | "denied";
  result?: unknown;
  error?: string;
};

const schema = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: "function" as const,
  function: {
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});

const pathProperty = {
  type: "string",
  description: "Relative path inside the MONSTER AI workspace. Never use absolute paths or '..'.",
};

export const WORKSPACE_TOOLS = [
  schema(
    "workspace_list_files",
    "List files and directories inside the MONSTER AI project root. Use '.' for the project root.",
    { path: pathProperty },
    ["path"],
  ),
  schema(
    "workspace_read_file",
    "Read a UTF-8 text file from the MONSTER AI project root. Maximum file size 1 MB.",
    { path: pathProperty },
    ["path"],
  ),
  schema(
    "workspace_write_file",
    "Create or overwrite a UTF-8 text file inside the restricted workspace directory. Parent directories are created when needed.",
    {
      path: pathProperty,
      content: { type: "string" },
    },
    ["path", "content"],
  ),
  schema(
    "workspace_append_file",
    "Append UTF-8 text to an existing file inside the restricted workspace directory.",
    {
      path: pathProperty,
      content: { type: "string" },
    },
    ["path", "content"],
  ),
  schema(
    "workspace_create_directory",
    "Create a directory inside the restricted workspace directory.",
    { path: pathProperty },
    ["path"],
  ),
] as const;

async function getRoot(toolName: string): Promise<string> {
  const isReadOperation =
    toolName === "workspace_list_files" ||
    toolName === "workspace_read_file";

  if (isReadOperation) {
    return realpath(path.resolve(process.cwd()));
  }

  const configuredRoot = path.resolve(process.cwd(), "workspace");
  await mkdir(configuredRoot, { recursive: true });
  return realpath(configuredRoot);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateRelativePath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A non-empty relative path is required.");
  }

  const normalized = input.replace(/\\/g, "/").trim();

  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) =>
      part === ".." || isBlockedPathSegment(part)
    )
  ) {
    throw new Error("Unsafe or restricted path. This path is not accessible through workspace tools.");
  }

  return normalized === "." ? "" : normalized;
}

async function ensureSafeDirectory(
  root: string,
  relative: string,
  create: boolean,
): Promise<string> {
  let current = root;

  if (!relative) return current;

  const parts = relative.split("/").filter(Boolean);

  for (const part of parts) {
    current = path.join(current, part);

    try {
      const info = await lstat(current);

      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Workspace paths cannot traverse symlinks or non-directories.");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== "ENOENT" || !create) throw error;

      await mkdir(current);
    }

    const resolved = await realpath(current);

    if (!isInside(root, resolved)) {
      throw new Error("Path escaped the workspace boundary.");
    }

    current = resolved;
  }

  return current;
}

async function resolveFile(
  root: string,
  relative: string,
  createParents: boolean,
): Promise<string> {
  const parts = relative.split("/").filter(Boolean);

  if (parts.length === 0) {
    throw new Error("A file path is required.");
  }

  const filename = parts.pop()!;
  const parentRelative = parts.join("/");
  const parent = await ensureSafeDirectory(root, parentRelative, createParents);
  const target = path.join(parent, filename);

  if (!isInside(root, target)) {
    throw new Error("Path escaped the workspace boundary.");
  }

  try {
    const info = await lstat(target);

    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Target must be a regular file, not a symlink or directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return target;
}

function validateContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new Error("content must be a string.");
  }

  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("Content exceeds the 1 MB limit.");
  }

  return content;
}

async function executeWorkspaceToolUnsafe(
  name: string,
  rawArguments: string,
): Promise<WorkspaceResult | null> {
  const supported = WORKSPACE_TOOLS.some(
    (item) => item.function.name === name,
  );

  if (!supported) return null;

  try {
    const args: unknown = JSON.parse(rawArguments);

    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("Arguments must be a JSON object.");
    }

    const input = args as Record<string, unknown>;
    const relative = validateRelativePath(input.path);
    const root = await getRoot(name);

    switch (name) {
      case "workspace_list_files": {
        const directory = await ensureSafeDirectory(root, relative, false);
        const entries = await readdir(directory, { withFileTypes: true });

        return {
          ok: true,
          tool: name,
          result: entries
            .filter((entry) => !isBlockedPathSegment(entry.name))
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory()
                ? "directory"
                : entry.isFile()
                  ? "file"
                  : "other",
            })),
        };
      }

      case "workspace_read_file": {
        const target = await resolveFile(root, relative, false);
        const info = await lstat(target);

        if (info.size > MAX_FILE_BYTES) {
          throw new Error("File exceeds the 1 MB read limit.");
        }

        const content = await readFile(target, "utf8");

        return {
          ok: true,
          tool: name,
          result: {
            path: relative,
            content,
            bytes: info.size,
          },
        };
      }

      case "workspace_write_file": {
        const content = validateContent(input.content);
        const target = await resolveFile(root, relative, true);

        await writeFile(target, content, {
          encoding: "utf8",
          flag: "w",
        });

        return {
          ok: true,
          tool: name,
          result: {
            path: relative,
            bytesWritten: Buffer.byteLength(content, "utf8"),
            operation: "write",
          },
        };
      }

      case "workspace_append_file": {
        const content = validateContent(input.content);
        const target = await resolveFile(root, relative, false);
        const info = await lstat(target);

        if (info.size + Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          throw new Error("Result would exceed the 1 MB file limit.");
        }

        await appendFile(target, content, "utf8");

        return {
          ok: true,
          tool: name,
          result: {
            path: relative,
            bytesAppended: Buffer.byteLength(content, "utf8"),
            operation: "append",
          },
        };
      }

      case "workspace_create_directory": {
        const directory = await ensureSafeDirectory(root, relative, true);

        return {
          ok: true,
          tool: name,
          result: {
            path: relative || ".",
            created: true,
            directory,
          },
        };
      }

      default:
        return null;
    }
  } catch (error) {
    return {
      ok: false,
      tool: name,
      error:
        error instanceof Error
          ? error.message
          : "Unknown workspace operation error.",
    };
  }
}
// WORKSPACE_DURABLE_REPLAY_V1
export type WorkspaceToolExecution = {
  taskId: string;
  runId: string;
  correlationId: string | null;
  agentId: string;
  operationIndex: number;
  operationKey: string;
  argumentsHash: string;
};

const WORKSPACE_MUTATION_TOOLS = new Set([
  "workspace_write_file",
  "workspace_append_file",
  "workspace_create_directory",
]);

function workspaceUnknown(name: string, error: string): WorkspaceResult {
  return { ok: false, status: "outcome_unknown", tool: name, error };
}

async function executeDurableWorkspaceMutation(
  name: string,
  rawArguments: string,
  execution: WorkspaceToolExecution,
): Promise<WorkspaceResult> {
  const pool = getPostgresPool();
  let client: PoolClient | null = null;
  let lockAcquired = false;
  let transactionOpen = false;
  let discardClient = false;
  const lockKey = `monster-ai-side-effect:${execution.taskId}:${execution.operationKey}`;

  try {
    client = await pool.connect();

    // A session advisory lock serializes retries of the same logical side effect.
    // PostgreSQL releases it automatically if the Worker process/connection dies.
    const lockDeadline = Date.now() + 30_000;
    while (Date.now() < lockDeadline) {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked",
        [lockKey],
      );
      if (lock.rows[0]?.locked === true) {
        lockAcquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!lockAcquired) {
      return workspaceUnknown(
        name,
        "Another execution still holds this operation lock. The operation was not replayed; reconcile before retrying.",
      );
    }

    const prior = await client.query<{
      tool_name: string | null;
      event_type: string;
      details: Record<string, unknown> | null;
    }>(
      `SELECT tool_name, event_type, details
       FROM public.task_events
       WHERE task_id = $1::uuid
         AND details->>'operationIndex' = $2::text
         AND event_type IN ('tool.execution_started', 'tool.execution_succeeded')
       ORDER BY id ASC`,
      [execution.taskId, execution.operationIndex],
    );

    // Stable lookup by task + logical operation index also recognizes legacy
    // per-tool receipts and detects a changed tool plan across retries.
    for (const row of prior.rows) {
      const details = row.details ?? {};
      if (row.tool_name !== name || details.tool !== name) {
        return workspaceUnknown(
          name,
          "Workspace operation identity conflict: this task step was already reserved by a different side-effecting tool. Automatic replay is unsafe.",
        );
      }
      if (details.argumentsHash !== execution.argumentsHash) {
        return workspaceUnknown(
          name,
          "Workspace operation idempotency conflict: this logical task step was recorded with different arguments. Automatic replay is unsafe.",
        );
      }
    }
    const successes = prior.rows.filter((row) => row.event_type === "tool.execution_succeeded");
    if (successes.length > 1) {
      return workspaceUnknown(name, "Multiple success receipts exist for this operation. Manual reconciliation is required.");
    }

    if (successes.length === 1) {
      const details = successes[0].details ?? {};
      if (!Object.prototype.hasOwnProperty.call(details, "result")) {
        return workspaceUnknown(name, "Stored workspace success receipt has no result. Manual reconciliation is required.");
      }
      return {
        ok: true,
        status: "succeeded",
        tool: name,
        result: details.result,
      };
    }

    if (prior.rows.some((row) => row.event_type === "tool.execution_started")) {
      return workspaceUnknown(
        name,
        "A prior execution started but has no durable success receipt. The filesystem outcome is unknown; automatic replay is suppressed.",
      );
    }

    // Commit the start marker before touching the filesystem. If the process dies
    // at any later point, a retry will see this marker and fail closed.
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'tool.execution_started', 'info', false, $6::jsonb)`,
      [
        execution.taskId,
        execution.runId,
        execution.correlationId,
        execution.agentId,
        name,
        JSON.stringify({
          tool: name,
          operationIndex: execution.operationIndex,
          operationKey: execution.operationKey,
          argumentsHash: execution.argumentsHash,
        }),
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;

    // The existing implementation performs all path checks and filesystem work.
    // Any error after the durable start marker is treated as uncertain.
    const operation = await executeWorkspaceToolUnsafe(name, rawArguments);
    if (!operation || operation.ok !== true) {
      return workspaceUnknown(
        name,
        operation?.error ?? "Workspace operation did not return a successful result after it was started.",
      );
    }

    // Store the result after the filesystem operation. If this commit is lost,
    // the start marker remains and retries are blocked rather than duplicated.
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'tool.execution_succeeded', 'info', true, $6::jsonb)`,
      [
        execution.taskId,
        execution.runId,
        execution.correlationId,
        execution.agentId,
        name,
        JSON.stringify({
          tool: name,
          operationIndex: execution.operationIndex,
          operationKey: execution.operationKey,
          argumentsHash: execution.argumentsHash,
          result: operation.result,
        }),
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;

    return { ...operation, status: "succeeded" };
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
      transactionOpen = false;
    }
    return workspaceUnknown(
      name,
      error instanceof Error ? error.message : "Workspace operation outcome is unknown.",
    );
  } finally {
    if (client) {
      if (lockAcquired) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked",
            [lockKey],
          );
          if (unlocked.rows[0]?.unlocked !== true) discardClient = true;
        } catch {
          // Destroy rather than return a session with an uncertain advisory lock to the pool.
          discardClient = true;
        }
      }
      client.release(discardClient);
    }
  }
}

export async function executeWorkspaceTool(
  name: string,
  rawArguments: string,
  execution?: WorkspaceToolExecution,
): Promise<WorkspaceResult | null> {
  const supported = WORKSPACE_TOOLS.some(
    (item) => item.function.name === name,
  );
  if (!supported) return null;

  if (!WORKSPACE_MUTATION_TOOLS.has(name)) {
    const result = await executeWorkspaceToolUnsafe(name, rawArguments);
    return result ? { ...result, status: result.ok ? "succeeded" : "failed" } : null;
  }

  if (!execution) {
    return {
      ok: false,
      status: "denied",
      tool: name,
      error: "Durable task execution context is required for workspace mutations.",
    };
  }

  return executeDurableWorkspaceMutation(name, rawArguments, execution);
}
