import { randomUUID } from "node:crypto";
import { getPostgresPool } from "../db/postgres";

export type MemoryRecord = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type MemoryDbRow = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("PostgreSQL returned an invalid memory timestamp.");
  }
  return date.toISOString();
}

function mapMemoryRow(row: MemoryDbRow): MemoryRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function readAll(): Promise<MemoryRecord[]> {
  const result = await getPostgresPool().query<MemoryDbRow>(`
    SELECT
      id::text AS id,
      title,
      content,
      category,
      tags,
      created_at,
      updated_at
    FROM public.memories
    ORDER BY updated_at DESC, id ASC
  `);

  return result.rows.map(mapMemoryRow);
}

export async function saveMemory(
  input: {
    title: string;
    content: string;
    category: string;
    tags: string[];
  },
  execution?: {
    taskId: string;
    runId: string;
    correlationId: string | null;
    agentId: string;
    operationIndex: number;
    operationKey: string;
    argumentsHash: string;
  },
) {
  if (
    !input ||
    typeof input.title !== "string" ||
    typeof input.content !== "string" ||
    typeof input.category !== "string" ||
    !Array.isArray(input.tags) ||
    !input.tags.every((tag) => typeof tag === "string")
  ) {
    throw new Error("Invalid memory input.");
  }

  const title = input.title.trim();
  const content = input.content.trim();
  const category = input.category.trim().toLowerCase();
  const normalizedTags = input.tags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  if (!title || !content || !category) {
    throw new Error("title, content and category are required.");
  }
  if (title.length > 200 || content.length > 10_000 || normalizedTags.length > 20) {
    throw new Error("Memory exceeds the allowed size.");
  }

  const tags = [...new Set(normalizedTags)];
  const id = randomUUID();
  const now = new Date().toISOString();
  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize all side effects for this task step across Memory and Workspace.
    // This transaction lock conflicts with Workspace's session advisory lock.
    if (execution) {
      const sideEffectLockKey = `monster-ai-side-effect:${execution.taskId}:${execution.operationKey}`;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [sideEffectLockKey],
      );
    }

    // Preserve the independent global memory-capacity serialization.
    await client.query("SELECT pg_advisory_xact_lock(1349850020, 1)");

    // Memory mutation and its success receipt remain in the same transaction.
    // Query by task + operationIndex so changed tool plans fail closed, including
    // legacy workspace/memory receipts written before this unified identity patch.
    if (execution) {
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

      for (const row of prior.rows) {
        const details = row.details ?? {};
        if (row.tool_name !== "memory_save" || details.tool !== "memory_save") {
          throw new Error(
            "Memory save operation identity conflict: this task step was already reserved by a different side-effecting tool. Automatic replay is unsafe.",
          );
        }
        if (details.argumentsHash !== execution.argumentsHash) {
          throw new Error(
            "Memory save idempotency conflict: this task step was already committed with different arguments. Automatic replay is unsafe.",
          );
        }
      }

      const successes = prior.rows.filter((row) => row.event_type === "tool.execution_succeeded");
      if (successes.length > 1) {
        throw new Error("Multiple memory success receipts exist for this operation; outcome is unknown.");
      }

      if (successes.length === 1) {
        const details = successes[0].details ?? {};
        const cached = details.result as { action?: unknown; memory?: unknown } | undefined;
        if (!cached || (cached.action !== "created" && cached.action !== "updated") || !cached.memory) {
          throw new Error("Stored memory execution receipt is incomplete; outcome is unknown.");
        }
        await client.query("COMMIT");
        return cached as { action: "created" | "updated"; memory: MemoryRecord };
      }

      if (prior.rows.some((row) => row.event_type === "tool.execution_started")) {
        throw new Error("A prior side-effect execution started at this task step without a success receipt. Automatic replay is unsafe.");
      }
    }
    const existing = await client.query<MemoryDbRow>(
      `
        SELECT
          id::text AS id,
          title,
          content,
          category,
          tags,
          created_at,
          updated_at
        FROM public.memories
        WHERE lower(title) = lower($1)
          AND lower(category) = lower($2)
        LIMIT 1
        FOR UPDATE
      `,
      [title, category],
    );

    let row: MemoryDbRow;
    let action: "created" | "updated";

    if (existing.rows[0]) {
      const updated = await client.query<MemoryDbRow>(
        `
          UPDATE public.memories
          SET content = $2,
              tags = $3::text[],
              updated_at = $4::timestamptz
          WHERE id = $1::uuid
          RETURNING
            id::text AS id,
            title,
            content,
            category,
            tags,
            created_at,
            updated_at
        `,
        [existing.rows[0].id, content, tags, now],
      );
      row = updated.rows[0];
      action = "updated";
    } else {
      const countResult = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.memories",
      );
      if (countResult.rows[0].count >= 2_000) {
        throw new Error("Memory capacity reached (2000 records).");
      }

      const inserted = await client.query<MemoryDbRow>(
        `
          INSERT INTO public.memories
            (id, title, content, category, tags, created_at, updated_at)
          VALUES
            ($1::uuid, $2, $3, $4, $5::text[], $6::timestamptz, $6::timestamptz)
          RETURNING
            id::text AS id,
            title,
            content,
            category,
            tags,
            created_at,
            updated_at
        `,
        [id, title, content, category, tags, now],
      );
      row = inserted.rows[0];
      action = "created";
    }

    if (!row) {
      throw new Error("PostgreSQL did not return the saved memory record.");
    }

    const output = { action, memory: mapMemoryRow(row) };
    if (execution) {
      await client.query(
        `INSERT INTO public.task_events
          (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'memory_save', 'tool.execution_succeeded', 'info', true, $5::jsonb)`,
        [
          execution.taskId,
          execution.runId,
          execution.correlationId,
          execution.agentId,
          JSON.stringify({
            tool: "memory_save",
            operationIndex: execution.operationIndex,
            operationKey: execution.operationKey,
            argumentsHash: execution.argumentsHash,
            result: output,
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return output;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original database error; the connection is released below.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function searchMemories(query: string, limit = 8) {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];

  const tokens = [...new Set(clean.split(/\s+/).filter((token) => token.length > 1))];
  if (!tokens.length) return [];

  const records = await readAll();
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 8;
  const safeLimit = Math.max(1, Math.min(requestedLimit, 20));

  return records
    .map((memory) => {
      const haystack = [
        memory.title,
        memory.content,
        memory.category,
        ...memory.tags,
      ].join(" ").toLowerCase();

      const score = tokens.reduce(
        (total, token) => total + (haystack.includes(token) ? 1 : 0),
        0,
      );

      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.updatedAt.localeCompare(a.memory.updatedAt),
    )
    .slice(0, safeLimit)
    .map((item) => item.memory);
}

export async function listMemories(category = "all") {
  const records = await readAll();
  const normalizedCategory = category.toLowerCase();
  const filtered =
    normalizedCategory === "all"
      ? records
      : records.filter((item) => item.category === normalizedCategory);

  return filtered
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
}

export async function executeMemoryTool(
  name: string,
  rawArguments: string,
  execution?: {
    taskId: string;
    runId: string;
    correlationId: string | null;
    agentId: string;
    operationIndex: number;
    operationKey: string;
    argumentsHash: string;
  },
) {
  let memorySaveStarted = false;
  try {
    const args: unknown = JSON.parse(rawArguments);
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    const data = args as Record<string, unknown>;

    if (name === "memory_save") {
      if (
        typeof data.title !== "string" ||
        typeof data.content !== "string" ||
        typeof data.category !== "string" ||
        !Array.isArray(data.tags) ||
        !data.tags.every((tag) => typeof tag === "string")
      ) {
        throw new Error("Invalid memory_save arguments.");
      }

      memorySaveStarted = true;
      return {
        ok: true,
        status: "succeeded" as const,
        tool: name,
        result: await saveMemory({
          title: data.title,
          content: data.content,
          category: data.category,
          tags: data.tags as string[],
        }, execution),
      };
    }

    if (name === "memory_search") {
      if (typeof data.query !== "string") throw new Error("query is required.");
      return {
        ok: true,
        status: "succeeded" as const,
        tool: name,
        result: await searchMemories(data.query),
      };
    }

    if (name === "memory_list") {
      if (typeof data.category !== "string") {
        throw new Error("category is required; use 'all' for every category.");
      }
      return {
        ok: true,
        status: "succeeded" as const,
        tool: name,
        result: await listMemories(data.category),
      };
    }

    return null;
  } catch (error) {
    return {
      ok: false,
      status: name === "memory_save" && memorySaveStarted ? "outcome_unknown" as const : "failed" as const,
      tool: name,
      error: error instanceof Error ? error.message : "Memory operation failed.",
    };
  }
}
