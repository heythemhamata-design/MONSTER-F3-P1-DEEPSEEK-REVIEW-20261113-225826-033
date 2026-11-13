import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildToolExecutionIdentity } from "../lib/agents/runtime";
import { CURRENT_TOOL_POLICY_VERSION, resolveAgentToolGrant, resolvePersistedAgentToolGrant, TOOL_REPLAY_CLASS } from "../lib/ai/tool-policy";
import { enqueueTaskTx, type EnqueueTaskInput } from "../lib/tasks/queue";

async function main(): Promise<void> {
  console.log("========== MONSTER F3 P1 TEST ==========");

  // A. Tool identity split: task identity always survives; effect identity is side-effect-only.
  const identity = { taskId: randomUUID(), runId: randomUUID(), correlationId: "p1-identity-test" };
  const safe = buildToolExecutionIdentity(identity, "safe-replay", undefined);
  assert.deepEqual(safe, { taskIdentity: identity });
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "effectIdentity"), false);
  const strict = buildToolExecutionIdentity(identity, "strict", 0);
  assert.deepEqual(strict, { taskIdentity: identity, effectIdentity: { ...identity, operationIndex: 0 } });
  const explicit = buildToolExecutionIdentity(identity, "explicit", 1);
  assert.deepEqual(explicit.effectIdentity, { ...identity, operationIndex: 1 });
  assert.deepEqual(buildToolExecutionIdentity(undefined, "explicit", 0), {});
  assert.equal(TOOL_REPLAY_CLASS.memory_search, "safe-replay");
  assert.equal(TOOL_REPLAY_CLASS.web_search, "safe-replay");
  assert.equal(TOOL_REPLAY_CLASS.memory_save, "strict");
  assert.equal(TOOL_REPLAY_CLASS.run_powershell, "explicit");
  console.log("TASK_IDENTITY_SAFE_REPLAY=PASS");
  console.log("EFFECT_IDENTITY_STRICT_EXPLICIT=PASS");

  // B. v1/v2 grants remain frozen; new tasks use v3 with the same v2 ceiling in P1.
  assert.equal(CURRENT_TOOL_POLICY_VERSION, 3);
  const v1 = resolvePersistedAgentToolGrant("researcher", ["calculate", "get_current_datetime"], 1);
  assert.deepEqual(v1, ["calculate", "get_current_datetime"]);
  assert.throws(() => resolvePersistedAgentToolGrant("researcher", ["calculate", "get_current_datetime", "web_search"], 1), /outside the maximum policy/);
  const v2 = resolvePersistedAgentToolGrant("researcher", ["calculate", "get_current_datetime", "web_search"], 2);
  assert.deepEqual(v2, ["calculate", "get_current_datetime", "web_search"]);
  const v3 = resolveAgentToolGrant("researcher");
  assert.deepEqual(v3, v2);
  assert.throws(() => resolvePersistedAgentToolGrant("researcher", v3, 99), /Unsupported tool policy version/);
  console.log("POLICY_V1_V2_FROZEN_V3_BASELINE=PASS");

  // C. enqueueTaskTx must use the caller's client and must not own a transaction.
  const statements: string[] = [];
  const metadataRows: Record<string, unknown>[] = [];
  const fakeClient = {
    async query(sqlValue: unknown, values?: unknown[]) {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.startsWith("SELECT id, enabled FROM agents")) {
        return { rows: [{ id: "researcher", enabled: true }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO tasks")) {
        metadataRows.push(JSON.parse(String(values?.[6])) as Record<string, unknown>);
        return { rows: [{ id: randomUUID(), status: "queued", agent_id: "researcher", priority: 100, max_attempts: 3, created_at: new Date("2026-01-01T00:00:00.000Z") }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  } as unknown as PoolClient;
  const input: EnqueueTaskInput = {
    agentId: "researcher",
    input: "P1 caller-owned transaction test",
    enableTools: true,
    correlationId: `p1-test-${randomUUID()}`,
  };
  const task = await enqueueTaskTx(fakeClient, input);
  assert.equal(task.status, "queued");
  assert.equal(task.agent_id, "researcher");
  assert.equal(task.dependencies.length, 0);
  assert.equal(metadataRows.length, 1);
  assert.equal(metadataRows[0].toolPolicyVersion, 3);
  assert.ok((metadataRows[0].allowedTools as string[]).includes("web_search"));
  assert.equal(statements.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)), false);
  assert.ok(statements.some((sql) => sql.startsWith("INSERT INTO task_events")));
  console.log("ENQUEUE_TASK_TX_CALLER_OWNS_TRANSACTION=PASS");

  console.log("F3_P1_TEST=PASS");
}

main().catch((error) => {
  console.error("F3_P1_TEST=FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
