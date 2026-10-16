# GitHub releases

The project distributes GitHub source installs and a downloadable `.tgz`
archive attached to GitHub Releases. It does not publish to the npm registry.
The existing `v0.3.0` tag is the initial automation baseline. Semantic-release
analyzes commits after the latest release tag on `main`, so the first automated
release may include eligible changes accumulated across more than one PR; later
runs start from the latest generated tag.

## Version selection

The analyzer and release-notes generator use the `conventionalcommits` preset.
As summarized in the [commit guide](maintainers/commits.md), `feat` selects a
minor release, `fix` and `perf` select a patch release, and `!` in the header or
a `BREAKING CHANGE:` footer selects a major release. Documentation, refactoring
and maintenance commits do not trigger a release by default. Do not change a
commit type to manufacture a version. Review the computed version and notes from
a disposable dry run before relying on a candidate, especially while establishing
the first release after `v0.3.0`. See the official
[commit-analyzer configuration](https://github.com/semantic-release/commit-analyzer#configuration)
for preset behavior.

## Workflow and permissions

The release job runs only after a push to `main` and only when the complete
Node.js 20, 22 and 24 CI matrix succeeds. It fetches full Git history, checks
that the tested commit is still the current `main` head, and runs the release
job on Node.js 24.15.0. The package and runtime continue to support Node.js 20
and newer; the Node 24 job does not raise the runtime minimum.

Runs are grouped by workflow and ref without canceling a running job; the
release job also skips a queued run if `main` has advanced past its tested SHA.
The workflow has read-only repository contents permission by default. Only the
release job receives `contents: write`; the workflow token is not persisted by
checkout or made available to build, test and verification steps. The final
release step receives it for GitHub API calls and uses a temporary Git askpass
helper for metadata/tag pushes. Pull requests do not run the release job. Merging
release-worthy commits to `main` can therefore create a public GitHub release
after the matrix succeeds; there is no separate manual version selector.
The workflow needs no npm publishing token, OIDC permission, personal access token,
or issue/PR write permission.

## Versioned source and archive

Before publishing, the typed preparation hook checks and synchronizes the
version in `package.json`, both root version fields in `package-lock.json`,
`.codex-plugin/plugin.json`, `src/version.ts`, and the three version-pinned
GitHub install commands in `README.md`. It then runs the build and package
checks and packs the tested package into an ignored `.release-artifacts/`
directory. The GitHub release attaches that exact `.tgz` archive to the `vX.Y.Z`
tag.

The release commit is intentional: a GitHub source install resolves the tagged
files, so the CLI's runtime version, plugin manifest, package archive and
README install pins must agree at that tag. The commit contains only the
versioned files above and uses `chore(release): <version> [skip ci]` to avoid a
release-workflow loop. This is a deliberate exception to semantic-release's
general recommendation to avoid generated release commits; see its
[GitHub Actions guidance](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions)
and [FAQ on release commits and tags](https://semantic-release.gitbook.io/semantic-release/support/faq).

## Preview and recovery

The Node 24 release-validation job runs on pull requests and pushes with
read-only contents permission and no publishing token. Its
`node dist/.github/release/verify-release-tooling.js` fixture loads the
configured plugins and runs semantic-release `--dry-run --no-ci` in a disposable
local bare Git repository. It uses a `v0.3.0` baseline, a synthetic breaking
commit, and a local config containing only the analyzer and notes generator. A
Git URL rewrite points the repository URL at the local bare remote; the fixture
never contacts GitHub or includes the GitHub publishing plugin in that dry run.
It asserts the candidate version and breaking notes.

```sh
node .github/release/node_modules/semantic-release/bin/semantic-release.js --dry-run --no-ci
```

This previews the candidate version and release notes without publishing. The
dry run does not prove GitHub asset upload. A second release-validation fixture
clones the source to a temporary directory, loads the configured prepare plugin
through semantic-release's actual normalizer, runs it with a synthetic next
patch version, builds and packs that version, installs the resulting archive
into a temporary consumer, and confirms the installed MCP runtime reports the
same version. A matrix fixture also performs a source-Git npm install with root
development dependencies only, proving that Git-based installs do not require
the isolated release toolchain. Neither fixture mutates the checkout, a user
Codex installation/configuration, or approval state. Only an actual main-branch
release job can exercise the GitHub release API and attachment.

Do not run a local no-CI release against the project remote or move a published
tag. If preparation fails before publishing, fix the cause through a reviewed
change and rerun the checks. If a tag or GitHub release already exists, inspect
its commit and assets before retrying; correct a published mistake with a
follow-up release rather than deleting or retargeting the existing tag. The
[semantic-release configuration guide](https://semantic-release.gitbook.io/semantic-release/usage/configuration)
describes the `main` release branch and existing-tag baseline behavior.
