import type { NormalizedAction } from '../action/types.ts';
import type { AppServerOptions } from '../runtime/protocol-types.ts';
export interface ReviewOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
export interface ReviewAdapters {
  authAvailable?: () => Promise<boolean>;
  runAppServer?: (prompt: string, options: AppServerOptions) => Promise<string>;
  approvalStore?: { has(action: NormalizedAction): Promise<boolean>; remember(action: NormalizedAction): Promise<void> };
  dependencyPolicyHome?: string;
}
