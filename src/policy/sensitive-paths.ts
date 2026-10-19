const SENSITIVE_PATH_COMPONENTS = new Set([
  ".aws",
  ".azure",
  ".buildkite",
  ".circleci",
  ".codex",
  ".config",
  ".docker",
  ".git",
  ".github",
  ".gitlab",
  ".gnupg",
  ".idea",
  ".kube",
  ".netrc",
  ".npm",
  ".npmrc",
  ".ssh",
  ".terraform",
  ".venv",
  ".vscode",
  "appdata",
  "browser",
  "browsers",
  "cloud",
  "config",
  "credential",
  "credentials",
  "gcloud",
  "keychain",
  "keychains",
  "kube",
  "kubernetes",
  "library",
  "node_modules",
  "passwords",
  "profile",
  "profiles",
  "secrets",
  "session",
  "tokens",
  "vendor",
  "venv",
  "workflows",
]);

export function sensitiveFileTarget(target: string, allowVerifiedNodeModules = false) {
  const components = target.split(/[\\/]+/u).filter(Boolean).map((component) => component.toLocaleLowerCase());
  const base = components.at(-1) ?? "";
  if (components.some((component) => component.startsWith(".env") || (SENSITIVE_PATH_COMPONENTS.has(component) && !(allowVerifiedNodeModules && component === "node_modules")))) return true;
  if (components.some((component) => /(?:config|settings|secret|credential|password|token|api[_-]?key|private[_-]?key|keychain|auth|profile|browser|cloud|kube)/iu.test(component))) return true;
  return /(?:\.pem|\.key|\.p12|\.pfx|\.kdbx|\.mobileprovision|\.netrc|\.npmrc|\.gpg|\.age|\.sqlite|\.db)$/iu.test(base);
}
