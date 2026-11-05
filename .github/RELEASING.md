# MobileCode releases

MobileCode publishes unsigned Apple-silicon macOS builds from `release-macos.yml`, the only workflow in this repository. It runs the desktop and device-preview tests, builds the bundled CLI and the desktop app, attaches the DMG to a GitHub release, and also keeps it as a workflow-run artifact.

## One-time GitHub setup

1. In **Settings → Actions → General**, enable GitHub Actions and allow actions created by GitHub and verified creators.
2. In **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**. The release workflow also declares its narrower `contents: write` permission.

No Apple secrets are required while builds are unsigned. macOS auto-update is intentionally disabled for unsigned builds because Squirrel.Mac requires code signing. Users download each release manually and must approve the app on first launch.

## Create a release

Open **Actions → Release macOS → Run workflow**, choose `dev`, and choose whether to publish immediately. The workflow reads the version from `packages/desktop/package.json` and creates the matching tag. For example, version `2.2.5` produces `v2.2.5`. If an unpublished tag or draft release already exists for that version, a manual run safely moves the tag to the selected commit. Published release tags remain immutable.

Pushing a `v*` tag is also supported and creates a draft release for review, but the tag version must match `packages/desktop/package.json`.

## Sync from OpenCode

Keep the `upstream` remote pointed at `https://github.com/anomalyco/opencode.git`, then merge upstream into MobileCode's `dev` branch:

```sh
git fetch upstream
git checkout dev
git merge upstream/dev
```

Keep upstream's internal `@opencode/*` workspace package names, `OPENCODE_*` environment variables, server protocol, and CLI terminology. They are implementation contracts, not installed-app identity, and retaining them minimizes merge conflicts. MobileCode-specific identity is limited to packaging metadata, application data directories, URL protocol, assets, and release configuration.

Upstream adds and changes workflows under `.github/workflows/`. MobileCode keeps only `release-macos.yml`, so delete any new upstream workflow files during the merge (`git rm`), and resolve modify/delete conflicts on removed workflows by keeping them deleted.

After resolving any branded-file conflicts, verify from `packages/desktop`:

```sh
bun test electron-builder.config.test.ts
bun typecheck
```

For a local unsigned release build, run `bun run build:macos` from the repository root.
