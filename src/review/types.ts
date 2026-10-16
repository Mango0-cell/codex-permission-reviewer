import type { NormalizedAction } from '../action/types.js';
import type { AppServerOptions } from '../runtime/protocol-types.js';
export interface ReviewOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
export interface ReviewAdapters {
  authAvailable?: () => Promise<boolean>;
  runAppServer?: (prompt: string, options: AppServerOptions) => Promise<string>;
  approvalStore?: { has(action: NormalizedAction): Promise<boolean>; remember(action: NormalizedAction): Promise<void> };
}
