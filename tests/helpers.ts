import type { ActionInput, Review } from "../src/action/types.js";

export const allow: Review = { verdict: 'allow', riskLevel: 'low', rationale: 'Reviewed.', detectedHazards: [], saferAlternative: '' };
export function action(overrides: Partial<ActionInput> & Record<string, unknown> = {}): ActionInput & Record<string, unknown> {
  return {
    operationKind: 'command', command: 'printf hello', workspaceRoots: ['/workspace'], cwd: '/workspace',
    reason: 'Inspect output', sideEffects: [], reversibility: 'reversible', userAuthorization: 'explicit',
    network: false, externalSystem: false, sensitiveData: false, ...overrides,
  };
}
