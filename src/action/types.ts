export type OperationKind = 'command' | 'file_read' | 'file_write' | 'file_delete' | 'file_move' | 'network_request' | 'database' | 'schema_change' | 'data_repair' | 'permission_change' | 'credential_change' | 'process_spawn' | 'deployment' | 'history_rewrite' | 'other';
export type Reversibility = 'reversible' | 'partially_reversible' | 'irreversible' | 'unknown';
export type UserAuthorization = 'none' | 'explicit';
export interface ActionFlag { involved: boolean; details: string[] }
export interface NormalizedAction {
  operationKind: OperationKind;
  command?: string | undefined;
  fileTargets?: string[] | undefined;
  workspaceRoots: string[];
  cwd: string;
  reason: string;
  sideEffects: string[];
  reversibility: Reversibility;
  userAuthorization: UserAuthorization;
  network: ActionFlag;
  externalSystem: ActionFlag;
  sensitiveData: ActionFlag;
}
export type ActionInput = Omit<NormalizedAction, 'network' | 'externalSystem' | 'sensitiveData'> & {
  network: boolean | { involved: boolean; destinations?: string[] };
  externalSystem: boolean | { involved: boolean; systems?: string[] };
  sensitiveData: boolean | { involved: boolean; kinds?: string[] };
};
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export interface Review {
  verdict: 'allow' | 'needs_user' | 'deny';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  rationale: string;
  detectedHazards: string[];
  saferAlternative: string;
}
export interface ReviewResult extends Review {
  actionSha256: string | null;
  reviewedAt: string;
  expiresAt: string;
  reviewStatus?: 'unavailable';
  retryable?: boolean;
  retryAfterMs?: number;
}
export interface FileVerification { verified: boolean; hazards: string[] }
