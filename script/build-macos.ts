#!/usr/bin/env bun

import { $ } from "bun"
import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const usage = `Usage: bun run build:macos [options]

Builds the MobileCode desktop app for macOS and writes a .app, .dmg and .zip
to packages/desktop/dist.

Options:
  --channel <dev|beta|prod>  Release channel (default: prod)
  --arch <arm64|x64|universal>
                             Target architecture (default: this machine)
  --sign                     Sign and notarize with your Developer ID.
                             Requires a certificate in your keychain and
                             APPLE_API_KEY, APPLE_API_KEY_ID and
                             APPLE_API_ISSUER in the environment.
  --skip-install             Skip "bun install"
  -h, --help                 Show this message`

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage)
  process.exit(0)
}

const value = (name: string) => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const known = ["--channel", "--arch", "--sign", "--skip-install", "--help", "-h"]
const unknown = args.find(
  (arg) => arg.startsWith("-") && !known.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
)
if (unknown) {
  console.error(`Unknown option: ${unknown}\n\n${usage}`)
  process.exit(1)
}

const channel = value("channel") ?? "prod"
if (!["dev", "beta", "prod"].includes(channel)) {
  console.error(`--channel must be dev, beta or prod\n\n${usage}`)
  process.exit(1)
}

const arch = value("arch") ?? (os.arch() === "arm64" ? "arm64" : "x64")
if (!["arm64", "x64", "universal"].includes(arch)) {
  console.error(`--arch must be arm64, x64 or universal\n\n${usage}`)
  process.exit(1)
}

if (process.platform !== "darwin") {
  console.error("This script builds the macOS app and only runs on macOS.")
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "..")
const desktop = path.join(root, "packages", "desktop")

// electron-builder loads ESM dependencies through require(), which Node supports from 22.12.
// Prefer whatever is on PATH and fall back to the newest compatible nvm install.
function ensureNode() {
  const version = (binary: string) => {
    const result = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "ignore" })
    if (!result.success) return undefined
    const parsed = /^v(\d+)\.(\d+)/.exec(result.stdout.toString().trim())
    if (!parsed) return undefined
    return { major: Number(parsed[1]), minor: Number(parsed[2]), label: result.stdout.toString().trim() }
  }

  const current = version("node")
  if (current && (current.major > 22 || (current.major === 22 && current.minor >= 12))) return current.label

  const versions = path.join(os.homedir(), ".nvm", "versions", "node")
  const candidates = existsSync(versions)
    ? readdirSync(versions)
        .map((name) => ({ name, version: version(path.join(versions, name, "bin", "node")) }))
        .filter((entry) =>
          Boolean(
            entry.version && (entry.version.major > 22 || (entry.version.major === 22 && entry.version.minor >= 12)),
          ),
        )
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    : []

  for (const candidate of candidates) {
    const bin = path.join(versions, candidate.name, "bin")
    process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`
    console.log(`  using Node ${candidate.name} from nvm`)
    return candidate.name
  }

  console.error(
    current === undefined
      ? "Node.js was not found on PATH. Install Node 22.12 or newer and try again."
      : `Node ${current.label} is too old. This build needs Node 22.12 or newer; install one and try again.`,
  )
  process.exit(1)
}

const step = (message: string) => console.log(`\n\x1b[1m${message}\x1b[0m`)

step("Checking tools")
const node = ensureNode()
console.log(`  node ${node}, bun ${Bun.version}, channel ${channel}, arch ${arch}`)

process.env["OPENCODE_CHANNEL"] = channel
process.env["MOBILECODE_UPDATER_ENABLED"] = args.includes("--sign") ? "true" : "false"
if (!args.includes("--sign")) {
  // Ad-hoc signing only. Gatekeeper will ask on first launch.
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
}

if (!args.includes("--skip-install")) {
  step("Installing dependencies")
  await $`bun install`.cwd(root)
}

step("Preparing icons, metadata and the bundled server")
await $`bun ./scripts/prebuild.ts`.cwd(desktop)

step("Building the app bundle")
await $`bun run build`.cwd(desktop)

step("Packaging for macOS")
const archFlag = arch === "universal" ? "--universal" : `--${arch}`
await $`bun x electron-builder --mac ${archFlag} --publish never --config electron-builder.config.ts`.cwd(desktop)

step("Done")
const dist = path.join(desktop, "dist")
for (const entry of readdirSync(dist).sort()) {
  if (entry.endsWith(".dmg") || entry.endsWith(".zip")) console.log(`  ${path.join(dist, entry)}`)
}
const bundle = readdirSync(dist)
  .filter((entry) => entry.startsWith("mac"))
  .flatMap((entry) => readdirSync(path.join(dist, entry)).map((app) => path.join(dist, entry, app)))
  .find((entry) => entry.endsWith(".app"))
if (bundle) console.log(`  ${bundle}`)
if (!args.includes("--sign")) {
  console.log("\n  This build is unsigned. On first launch, right-click the app and choose Open.")
}
