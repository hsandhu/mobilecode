# MobileCode releases

MobileCode publishes unsigned Apple-silicon macOS builds from `release-macos.yml`. The workflow creates a GitHub release with the DMG, ZIP, and `latest-mac.yml`, and also retains those files as workflow-run artifacts.

## One-time GitHub setup

1. In **Settings → Actions → General**, enable GitHub Actions and allow actions created by GitHub and verified creators.
2. In the **Actions** tab, disable inherited OpenCode workflows that MobileCode does not use. Leave **Release macOS** enabled. Workflow enabled/disabled state is stored by GitHub, so this avoids changing upstream workflow files and keeps upstream merges straightforward.
3. In **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**. The release workflow also declares its narrower `contents: write` permission.

No Apple secrets are required while builds are unsigned. macOS auto-update is intentionally disabled for unsigned builds because Squirrel.Mac requires code signing. Users download each release manually and must approve the app on first launch.

## Create a release

Open **Actions → Release macOS → Run workflow**, choose `dev`, and choose whether to publish immediately. The workflow reads the version from `packages/opencode/package.json` and creates the matching tag. For example, OpenCode version `1.18.29` produces `v1.18.29`. Reruns accept that tag only when it still points to the selected commit.

Pushing a `v*` tag is also supported and creates a draft release for review, but the tag version must match `packages/opencode/package.json`.

## Sync from OpenCode

Keep the `upstream` remote pointed at `https://github.com/anomalyco/opencode.git`, then merge upstream into MobileCode's `dev` branch:

```sh
git fetch upstream
git checkout dev
git merge upstream/dev
```

Keep upstream's internal `@opencode-ai/*` workspace package names, `OPENCODE_*` environment variables, server protocol, and CLI terminology. They are implementation contracts, not installed-app identity, and retaining them minimizes merge conflicts. MobileCode-specific identity is limited to packaging metadata, application data directories, URL protocol, assets, and release configuration.

After resolving any branded-file conflicts, verify from `packages/desktop`:

```sh
bun test electron-builder.config.test.ts
bun typecheck
```

For a local unsigned release build, run `bun run build:macos` from the repository root.
