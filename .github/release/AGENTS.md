# Release tooling

Own the GitHub-only semantic-release toolchain and the typed preparation plugin
that synchronizes source-install metadata and builds the downloadable archive.
The root package remains the only runtime package; release tooling stays under
this directory and is installed only by Node 24+ release-validation and release
jobs.

The `.releaserc.json` at repository root resolves this directory's locked
plugins from a repository-root working directory. Keep plugin paths and release
asset paths explicit. The release workflow must run only on `main` after the
supported Node matrix succeeds, use full Git history, and grant `contents: write`
only to the release job. Never add npm publication, issue/PR comments, OIDC
publishing, or credential-file access.

The prepare plugin reads only package metadata and README/source version files,
validates all copies before writing, runs the clean build and archive checks,
and packs the tested build for the GitHub release. It never reads credentials,
approval state, user Codex configuration, or proposed commands. The metadata
commit is part of the source tag contract: pinned GitHub installs must build and
report the same version as the attached archive.

Validation: `npm run check`, `npm test`, `npm run test:package`, the isolated
source-Git install fixture, the versioned archive preparation smoke test through
semantic-release's actual plugin normalizer, the release-tooling analyzer/plugin
smoke test, a semantic-release dry run in a disposable local Git repository,
and `git diff --check`. Do not create a real tag or GitHub release while
validating.
