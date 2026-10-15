export const allow = { verdict: 'allow', riskLevel: 'low', rationale: 'Reviewed.', detectedHazards: [], saferAlternative: '' };
export function action(overrides = {}) {
  return {
    operationKind: 'command', command: 'printf hello', workspaceRoots: ['/workspace'], cwd: '/workspace',
    reason: 'Inspect output', sideEffects: [], reversibility: 'reversible', userAuthorization: 'explicit',
    network: false, externalSystem: false, sensitiveData: false, ...overrides,
  };
}
