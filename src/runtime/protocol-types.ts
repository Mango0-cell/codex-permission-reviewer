export type UnknownRecord = Record<string, unknown>;
export interface AppServerOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined; outputSchema: object }
export interface ExecutableIdentity { path: string; device: string; inode: string; size: string; mtimeMs: string; mode: string }
export interface SafeItem { type: 'userMessage' | 'reasoning' | 'agentMessage'; id: string; text?: string }
export interface ReviewState {
  responses: Map<number, UnknownRecord>;
  agentMessageCount: number;
  agentMessageId: string | null;
  agentText: string;
  completedAgentText: string | null | undefined;
  turnCompleted: boolean;
  expectedCwd: string;
  threadId: string | null;
  settingsThreadId: string | null;
  statusThreadId: string | null;
  turnId: string | null;
  tokenUsageThreadId: string | null;
  tokenUsageTurnId: string | null;
  sawExpectedEffort: boolean;
}
