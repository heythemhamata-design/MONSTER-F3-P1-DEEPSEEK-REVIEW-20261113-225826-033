import type { AgentId } from "@/lib/agents/registry";
import type { ToolName } from "@/lib/ai/tool-executor";

/**
 * Policy v2 introduced web_search and the fixed Windows action adapter.
 * Policy v3 is the F3 compatibility baseline; its initial ceiling matches v2.
 * Future capability additions must be v3-only and keep the v1/v2 ceilings frozen.
 */
export const CURRENT_TOOL_POLICY_VERSION = 3 as const;

/** Replay classification is independent of permissions. It never grants a tool. */
export type ToolReplayClass = "safe-replay" | "strict" | "explicit";

export const TOOL_REPLAY_CLASS: Record<ToolName, ToolReplayClass> = {
  calculate: "safe-replay",
  add_numbers: "safe-replay",
  get_current_datetime: "safe-replay",
  transform_text: "safe-replay",
  parse_json: "safe-replay",

  workspace_list_files: "safe-replay",
  workspace_read_file: "safe-replay",
  workspace_write_file: "strict",
  workspace_append_file: "explicit",
  workspace_create_directory: "strict",

  memory_save: "strict",
  memory_search: "safe-replay",
  memory_list: "safe-replay",

  // A read-only lookup can safely be repeated after a worker retry.
  web_search: "safe-replay",

  // The adapter can launch an external application or create a directory.
  // Never automatically replay it after a confirmed or uncertain outcome.
  run_powershell: "explicit",
};

/** True when a partial execution log contains a confirmed or uncertain side effect. */
export function hasUnsafeToolOutcome(
  entries: readonly { tool: string; status?: string; ok?: boolean }[],
): boolean {
  return entries.some((entry) => {
    const replayClass = TOOL_REPLAY_CLASS[entry.tool as ToolName];
    if (!replayClass || replayClass === "safe-replay") return false;

    const status = entry.status ?? (entry.ok === true ? "succeeded" : "failed");
    return status === "succeeded" || status === "outcome_unknown";
  });
}

/**
 * Interactive chat is a separate principal. It receives basic utilities and
 * read-only project-memory lookup/listing, never memory mutation, web search,
 * Windows actions, or workspace mutation.
 *
 * Project memory is shared by this single-user deployment; this is not
 * multi-tenant isolation.
 */
export const CHAT_ALLOWED_TOOLS = [
  "calculate",
  "add_numbers",
  "get_current_datetime",
  "transform_text",
  "parse_json",
  "memory_search",
  "memory_list",
] as const satisfies readonly ToolName[];

const GENERAL_TOOLS = ["get_current_datetime"] as const satisfies readonly ToolName[];

const WORKSPACE_READ_TOOLS = [
  "workspace_list_files",
  "workspace_read_file",
] as const satisfies readonly ToolName[];

const MEMORY_TOOLS = [
  "memory_search",
  "memory_save",
  "memory_list",
] as const satisfies readonly ToolName[];

const RESEARCH_TOOLS = ["web_search"] as const satisfies readonly ToolName[];

/**
 * This is not permission to execute arbitrary PowerShell text.
 * The executor must accept only named, validated actions and fixed argument
 * schemas (for example: open_url with validated HTTPS/HTTP URL, or a bounded
 * workspace directory action delegated to workspace tools).
 */
const CONTROLLED_WINDOWS_ACTIONS = [
  "run_powershell",
] as const satisfies readonly ToolName[];

/**
 * Maximum tool capabilities for each agent. This is a server-owned ceiling,
 * not a list that an LLM, API request, or persisted task may expand.
 */
export const MAX_TOOLS_BY_AGENT: Record<AgentId, readonly ToolName[]> = {
  chief_of_staff: [],
  memory: ["transform_text", ...GENERAL_TOOLS, ...MEMORY_TOOLS],

  // Strategist can research and invoke only the executor's fixed Windows actions.
  strategist: [
    "calculate",
    ...GENERAL_TOOLS,
    ...RESEARCH_TOOLS,
    ...CONTROLLED_WINDOWS_ACTIONS,
  ],

  // Researcher is read-only with respect to the OS and can perform web lookup.
  researcher: ["calculate", ...GENERAL_TOOLS, ...RESEARCH_TOOLS],

  finance: ["calculate", "add_numbers", ...GENERAL_TOOLS],
  editor: ["transform_text", ...GENERAL_TOOLS],
  sales: ["transform_text", ...GENERAL_TOOLS],
  marketing: ["transform_text", ...GENERAL_TOOLS],
  ops: ["calculate", ...GENERAL_TOOLS, ...WORKSPACE_READ_TOOLS],
  social_media: ["transform_text", ...GENERAL_TOOLS],
  engineering: [
    "parse_json",
    "calculate",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
  design: ["transform_text", ...GENERAL_TOOLS],
  developer: [
    "parse_json",
    "calculate",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
  analytics: ["calculate", "parse_json", ...GENERAL_TOOLS],
  crm: ["parse_json", "transform_text", ...GENERAL_TOOLS],
  calendar: [...GENERAL_TOOLS],
  email: ["transform_text", ...GENERAL_TOOLS],
  drive: [
    "parse_json",
    "transform_text",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
};

/**
 * Default grants are conservative and are always checked against the maximum
 * server-owned ceiling above. No agent receives arbitrary shell execution.
 */
export const DEFAULT_TOOLS_BY_AGENT: Record<AgentId, readonly ToolName[]> = {
  chief_of_staff: [],
  memory: ["transform_text", ...GENERAL_TOOLS, ...MEMORY_TOOLS],

  strategist: [
    "calculate",
    ...GENERAL_TOOLS,
    ...RESEARCH_TOOLS,
    ...CONTROLLED_WINDOWS_ACTIONS,
  ],

  researcher: ["calculate", ...GENERAL_TOOLS, ...RESEARCH_TOOLS],

  finance: ["calculate", "add_numbers", ...GENERAL_TOOLS],
  editor: ["transform_text", ...GENERAL_TOOLS],
  sales: ["transform_text", ...GENERAL_TOOLS],
  marketing: ["transform_text", ...GENERAL_TOOLS],
  ops: ["calculate", ...GENERAL_TOOLS, ...WORKSPACE_READ_TOOLS],
  social_media: ["transform_text", ...GENERAL_TOOLS],
  engineering: [
    "parse_json",
    "calculate",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
  design: ["transform_text", ...GENERAL_TOOLS],
  developer: [
    "parse_json",
    "calculate",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
  analytics: ["calculate", "parse_json", ...GENERAL_TOOLS],
  crm: ["parse_json", "transform_text", ...GENERAL_TOOLS],
  calendar: [...GENERAL_TOOLS],
  email: ["transform_text", ...GENERAL_TOOLS],
  drive: [
    "parse_json",
    "transform_text",
    ...GENERAL_TOOLS,
    ...WORKSPACE_READ_TOOLS,
  ],
};

/**
 * Exact v1 ceiling retained only to validate already-persisted v1 tasks.
 * These legacy tasks never inherit web_search or run_powershell.
 */
/** Frozen exact v1 capability ceiling; never derive this from current policy constants. */
const LEGACY_V1_MAX_TOOLS_BY_AGENT: Record<AgentId, readonly ToolName[]> = {
  chief_of_staff: [],
  memory: ["transform_text", "get_current_datetime", "memory_search", "memory_save", "memory_list"],
  strategist: ["calculate", "get_current_datetime"],
  researcher: ["calculate", "get_current_datetime"],
  finance: ["calculate", "add_numbers", "get_current_datetime"],
  editor: ["transform_text", "get_current_datetime"],
  sales: ["transform_text", "get_current_datetime"],
  marketing: ["transform_text", "get_current_datetime"],
  ops: ["calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  social_media: ["transform_text", "get_current_datetime"],
  engineering: ["parse_json", "calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  design: ["transform_text", "get_current_datetime"],
  developer: ["parse_json", "calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  analytics: ["calculate", "parse_json", "get_current_datetime"],
  crm: ["parse_json", "transform_text", "get_current_datetime"],
  calendar: ["get_current_datetime"],
  email: ["transform_text", "get_current_datetime"],
  drive: ["parse_json", "transform_text", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
};

/** Frozen exact v2 ceiling; v3 additions must never leak into queued v2 tasks. */
const LEGACY_V2_MAX_TOOLS_BY_AGENT: Record<AgentId, readonly ToolName[]> = {
  chief_of_staff: [],
  memory: ["transform_text", "get_current_datetime", "memory_search", "memory_save", "memory_list"],
  strategist: ["calculate", "get_current_datetime", "web_search", "run_powershell"],
  researcher: ["calculate", "get_current_datetime", "web_search"],
  finance: ["calculate", "add_numbers", "get_current_datetime"],
  editor: ["transform_text", "get_current_datetime"],
  sales: ["transform_text", "get_current_datetime"],
  marketing: ["transform_text", "get_current_datetime"],
  ops: ["calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  social_media: ["transform_text", "get_current_datetime"],
  engineering: ["parse_json", "calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  design: ["transform_text", "get_current_datetime"],
  developer: ["parse_json", "calculate", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
  analytics: ["calculate", "parse_json", "get_current_datetime"],
  crm: ["parse_json", "transform_text", "get_current_datetime"],
  calendar: ["get_current_datetime"],
  email: ["transform_text", "get_current_datetime"],
  drive: ["parse_json", "transform_text", "get_current_datetime", "workspace_list_files", "workspace_read_file"],
};

function resolveAgainstCeiling(
  agentId: AgentId,
  requestedTools: readonly unknown[],
  maximum: readonly ToolName[],
): ToolName[] {
  if (!Array.isArray(requestedTools)) {
    throw new Error(`Tool grants for agent ${agentId} must be an array.`);
  }

  const resolved: ToolName[] = [];
  for (const candidate of requestedTools) {
    if (typeof candidate !== "string" || !maximum.includes(candidate as ToolName)) {
      throw new Error(
        `Tool grant rejected: ${String(candidate)} is outside the maximum policy for agent ${agentId}.`,
      );
    }

    const tool = candidate as ToolName;
    if (!resolved.includes(tool)) resolved.push(tool);
  }

  return resolved;
}

/**
 * Resolve task grants against the current server-owned agent ceiling.
 * - omitted grants use conservative v2 defaults;
 * - an explicit [] means no tools;
 * - unknown or out-of-policy grants are rejected rather than widened.
 */
export function resolveAgentToolGrant(
  agentId: AgentId,
  requestedTools?: readonly ToolName[],
): ToolName[] {
  const maximum = MAX_TOOLS_BY_AGENT[agentId];
  if (!maximum) {
    throw new Error(`Unknown agent policy: ${String(agentId)}.`);
  }

  const source: readonly unknown[] = requestedTools === undefined
    ? DEFAULT_TOOLS_BY_AGENT[agentId]
    : requestedTools;

  return resolveAgainstCeiling(agentId, source, maximum);
}

/**
 * Persisted task metadata is untrusted input. Missing metadata is fail-closed.
 *
 * v1 and v2 are checked against frozen historical ceilings.
 * v3 uses the current ceiling. Unknown versions fail closed.
 */
export function resolvePersistedAgentToolGrant(
  agentId: AgentId,
  persistedTools: unknown,
  persistedPolicyVersion: unknown,
): ToolName[] {
  if (
    persistedPolicyVersion === undefined &&
    (persistedTools === undefined || persistedTools === null)
  ) {
    return [];
  }

  if (!Array.isArray(persistedTools)) {
    throw new Error(`Persisted tool grants for agent ${agentId} are malformed.`);
  }

  if (persistedPolicyVersion === 1) {
    const legacyMaximum = LEGACY_V1_MAX_TOOLS_BY_AGENT[agentId];
    if (!legacyMaximum) {
      throw new Error(`Unknown legacy agent policy: ${String(agentId)}.`);
    }
    return resolveAgainstCeiling(agentId, persistedTools, legacyMaximum);
  }

  if (persistedPolicyVersion === 2) {
    const legacyMaximum = LEGACY_V2_MAX_TOOLS_BY_AGENT[agentId];
    if (!legacyMaximum) {
      throw new Error(`Unknown v2 agent policy: ${String(agentId)}.`);
    }
    return resolveAgainstCeiling(agentId, persistedTools, legacyMaximum);
  }

  if (persistedPolicyVersion !== CURRENT_TOOL_POLICY_VERSION) {
    throw new Error(
      `Unsupported tool policy version for agent ${agentId}: ${String(persistedPolicyVersion)}. ` +
      `Expected 1, 2, or ${CURRENT_TOOL_POLICY_VERSION}. Re-enqueue or migrate this task.`,
    );
  }

  return resolveAgentToolGrant(agentId, persistedTools as ToolName[]);
}
