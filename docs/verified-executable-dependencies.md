# Verified executable dependencies

Status: source implementation and review only. No installation, trusted manifest,
live permission review or previously denied database execution is authorized here.

## Operator configuration shape

The local file is an explicit policy change made by the host operator after
independently reviewing the action and code provenance. It is never generated
from caller claims or populated by a model. Its intended shape is:

```json
{
  "version": 1,
  "actions": [
    {
      "actionSha256": "<exact normalized action SHA-256>",
      "dependencies": [
        {
          "path": "/absolute/canonical/worktree/node_modules/package/cli.js",
          "sha256": "<independently reviewed file SHA-256>"
        }
      ]
    }
  ]
}
```

Placeholders are not valid hashes. Action digests use the existing
`actionSha256` normalization contract, including exact explicit authorization;
hashing only a command or pretty-printed JSON is not equivalent. Protect the
manifest's parent directories and keep the file owner-only. Creating or updating
this policy, installing the patch, and executing a reviewed action remain
separate host-controlled steps. The source task performs none of them.

## Trust boundary

The default policy remains unchanged. A host operator may configure a private
`plugin-state/codex-permission-reviewer/executable-dependencies.json` under the
server's canonical Codex home. Capture that home once at trusted service
composition; no MCP argument can select a manifest, hash, evidence or policy.
Same-UID process isolation remains the host's responsibility: filesystem modes
cannot distinguish an agent from another process running as its user.

The versioned manifest contains exact normalized-action SHA-256 values and, for
each action, exact canonical executable dependency paths and SHA-256 values.
This binds the exception to an operator-reviewed action, not arbitrary commands
that happen to name a pinned file. No directory, wildcard, relative path or
implicit dependency closure is permitted. Hashes are local policy data, not new
MCP fields. Read at most 64 KiB of manifest data, eight dependencies per action,
64 MiB per dependency and 128 MiB in aggregate; bound action count to eight.

## Narrow policy behavior

Require explicit authorization, a fresh model allow, an exact action-manifest
match and verified files. Only command, database and process-spawn actions may
use this verification. It only removes the `node_modules` path-component reason
for each exact verified dependency. All other sensitive components, credential
names, malformed/broad targets and destructive-command rules still reject.
Keep every declared target in the original prompt, action and action digest.
File reads/writes/moves/deletes, credential/permission changes and missing user
authorization gain no exception. Model deny and needs_user remain decisive.

Before opening dependency contents, reject noncanonical or symlinked paths,
hardlinks, nonregular files and other protected path components. Permit
JavaScript entrypoints (.js/.mjs/.cjs) or recognized native executable formats,
including extensionless engines. Native-format checks use a bounded header after
the path and identity checks; owner manifest registration asserts reviewed code provenance,
not absence of secrets. The verifier never executes or emits dependency bytes.
Reject group/world-writable files. Protect manifest ownership/private mode and
directory replacement boundaries; permit root-owned safe ancestors and sticky
temporary ancestors only when each verified file's path descends through an
owner-private directory. Windows does not support this optional verification;
ordinary review behavior remains available there.

Use no-follow descriptors and bounded streaming hashes. Compare descriptor/path
device, inode, size, mode and nanosecond modification/change timestamps before
and after reading. Parent snapshots retain directory identity, ownership and
permissions, excluding unrelated directory-listing timestamps. Retain the exact
manifest/file/parent snapshot, then sweep every file identity again after hashing
and parent checks. After model review, reverify against that original snapshot:
newly valid replacement policy
or files must not inherit the earlier review. Cancellation and total request
deadline cover verification. Any failure stops assisted approval.

## Evidence and limits

Tell the model which exact targets the host verified, without exposing file
bytes, manifest contents or secrets. State that hashes verify identity, not code
safety, imported files, dependency closure or future execution behavior. Bound
the complete prompt; do not truncate targets to fit host evidence.

Keep actionSha256's existing meaning. Add a separate decision-scope digest over
the action digest and verified host policy/file snapshot. Assisted decisions
must bypass result caches and learned-approval reads/writes; database operations
remain never-learned. Do not change existing mutation-learning restrictions.
Evidence is transient advisory data, not an execution wrapper or host permission.
The host must still recheck identity at execution; TOCTOU is not eliminated.

## Verification

Use inert commands, fixture bytes, private temporary homes and fake model/store
adapters. First demonstrate rejection of a correctly pinned fixture under the
old policy. Then cover positive approval, default behavior, deny/needs_user,
missing authorization, invalid/bounded manifests, partial trust, protected mixed
paths, symlinks/hardlinks, mode failures, in-place and atomic replacements,
parent changes, policy revocation, cancellation and no cache/learning reuse.
Run strict checking, full plugin tests, package smoke, dry-run packaging and diff
checks. Obtain independent security review; no live reviewer or install tests.

The source checkpoint passes strict TypeScript checking, 39 focused dependency
tests and all 197 plugin tests. Package smoke checks cover the built archive's
CLI, MCP, isolated installer, legacy imports and declarations. These fixture
checks do not establish live provider behavior or atomic execution binding.
