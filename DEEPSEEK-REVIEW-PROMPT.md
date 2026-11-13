# MONSTER F3 P1 â€” Independent Principal-Level Review (READ ONLY)

Act as an independent principal software architect and senior TypeScript/PostgreSQL reliability reviewer. Review ONLY the P1 changes, using `P1-ONLY.diff` as the change set. The `baseline/` directory is the verified pre-P1 source snapshot. `current/` is the post-P1 source. `new-files/` contains the newly added P1 test. `context-current/` contains supporting F1/F2 implementation and regression files that P1 is expected not to modify. `MANIFEST.txt` explains provenance and hashes.

## Hard constraints
- This is an audit, not an implementation request.
- Do not edit files, generate a patch, run mutating commands, create commits, or propose a broad redesign.
- Do not assume a passing test proves correctness. Independently trace each changed call path.
- Separate proven findings from hypotheses. Every finding must cite exact file path, symbol, and line range in the CURRENT source or diff.
- Check backward compatibility and cross-tool side-effect semantics, not just local types.

## P1 scope and invariants to verify
1. **TaskIdentity / EffectIdentity split**
   - TaskIdentity (taskId, runId, correlationId) must reach every agent tool execution context, including safe-replay tools.
   - EffectIdentity must be present only for `strict` / `explicit` effects and must add the stable operationIndex.
   - Verify that safe-replay tools never accidentally acquire effect identity, and that side-effect tools cannot run without the required durable identity.
   - Verify `open_url`, `run_powershell`, `memory_save`, and workspace mutation paths preserve F1 durable start/success receipts, operation keys, argument hashes, replay rejection, and crash recovery.
   - Verify the same logical task step cannot be reused across different side-effect tools to bypass cross-tool mutual exclusion.
   - Check operationIndex stability across model/tool loops, retries, worker lease recovery, and regenerated model responses.
   - Ensure task/effect identities are created by trusted runtime/worker code, never accepted from model output or client-controlled fields.
2. **Tool Policy v3 compatibility**
   - Verify v1 and v2 persisted task grants are resolved against independently frozen historical ceilings, not current mutable definitions.
   - Verify v3 initially matches the v2 ceiling and adds no grants in P1.
   - Verify unknown versions, unknown agents, malformed grants, and out-of-ceiling tools fail closed.
   - Check no legacy task can inherit v3-only capabilities and that new task metadata is persisted consistently as v3.
3. **enqueueTaskTx transaction semantics**
   - Verify `enqueueTaskTx(client, input)` uses only the caller-owned PoolClient and never begins, commits, rolls back, releases, or acquires another connection.
   - Verify the backward-compatible `enqueueTask(input)` wrapper owns BEGIN/COMMIT/ROLLBACK/release correctly.
   - Check all input validation, dependency locking/validation, task insert, metadata, task_dependencies, and task_events remain within the same transaction.
   - Identify error/partial-write cases and whether the caller can safely roll back atomically.
4. **Worker/runtime integration**
   - Verify the task identity is formed from the actual claimed task/run/correlation data and passed consistently through all runtime calls.
   - Verify agent id, abort signal, authorization grants, task lease fencing, cancellation, and completion behavior remain unchanged.
   - Check safe-replay, strict, and explicit classifications against the actual tool handlers.
5. **F1/F2 non-regression**
   - Verify F1 `tool.execution_started` / `tool.execution_succeeded` receipts and recovery/retry protection remain intact.
   - Verify F2 Researcher `web_search` grants/prompts and the frozen G1 baseline remain intact.
   - Note that provider network availability is outside the scope of this source-level P1 audit.

## Required output format
A. **Verdict**: PASS / PASS WITH FINDINGS / BLOCK.
B. **P0/P1 blockers**: only concrete correctness, security, data integrity, transaction, or duplicate-side-effect risks.
C. **P2/P3 findings**: maintainability, missing observability, non-blocking gaps.
D. **Invariant matrix**: each invariant above, PASS/FAIL/NOT PROVEN, with evidence.
E. **Test gap analysis**: explain what the new tests actually prove and list missing targeted tests; do not claim tests ran unless you ran them in a non-mutating environment.
F. **Minimal next actions**: smallest changes needed, no broad redesign.
G. **Do not approve a commit** unless no P0/P1 finding remains and all evidence supports the invariants.

Be strict. Do not infer code behavior from comments; follow executable logic. If required supporting code is not included, identify the exact missing file instead of guessing.