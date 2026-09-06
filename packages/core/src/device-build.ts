export * as DeviceBuild from "./device-build"

import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import launch from "cross-spawn"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import net from "net"
import os from "os"
import path from "path"

export type Exec = {
  readonly child: ChildProcess
  /** Resolves with the exit code once the process ends; never rejects. */
  readonly exit: Promise<number>
}

/** Spawn a command and stream combined output line by line. */
export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
  onLine?: (line: string) => void,
): Exec {
  // cross-spawn so `npx` and `pod` resolve the way they do in a terminal, on Windows too.
  const child = launch(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream || !onLine) continue
    let rest = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      const parts = (rest + chunk).split(/\r?\n/)
      rest = parts.pop() ?? ""
      for (const line of parts) {
        const text = line.trimEnd()
        if (text) onLine(text)
      }
    })
    stream.on("end", () => {
      if (rest.trim()) onLine(rest.trim())
    })
  }
  const exit = new Promise<number>((resolve) => {
    child.once("error", () => resolve(-1))
    child.once("close", (code) => resolve(code ?? -1))
  })
  return { child, exit }
}

/** Run a command purely for its stdout, e.g. a `-json` query. Empty string on failure. */
export async function capture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const out: string[] = []
  const running = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  })
  running.stdout?.setEncoding("utf8")
  running.stdout?.on("data", (chunk: string) => out.push(chunk))
  const code = await new Promise<number>((resolve) => {
    running.once("error", () => resolve(-1))
    running.once("close", (value) => resolve(value ?? -1))
  })
  return code === 0 ? out.join("") : ""
}

/** Direct child pids of `pid`. POSIX only; returns nothing when pgrep is unavailable. */
export function spawnPgrep(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
  return (result.stdout ?? "")
    .split("\n")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
}

// ── project discovery ─────────────────────────────────────────────────────────

const SKIP = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "out",
  "target",
  "Pods",
  "DerivedData",
  ".gradle",
  ".build",
  "vendor",
  "Carthage",
])
const MAX_DEPTH = 2
const EXPO_CONFIGS = ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"]
const GRADLE_MARKERS = ["settings.gradle", "settings.gradle.kts", "gradlew", "build.gradle", "build.gradle.kts"]

export type Project = {
  readonly platform: Platform
  /** Directory holding the native project for this platform. */
  readonly directory: string
  /** JavaScript project root (package.json, app.json) for Expo and React Native apps; else `directory`. */
  readonly root: string
  readonly framework: Framework
  /** True when the directory is an Expo app with no native project generated yet. */
  readonly needsPrebuild: boolean
}

export type Platform = "ios" | "android"
export type Framework = DevicePreview.Framework

/**
 * Find the native project root for each platform at or below `directory`.
 * Bounded walk: agents and templates routinely nest the app one or two levels
 * down, so a listing of just the session directory misses them.
 */
export function findProjects(directory: string): Project[] {
  const found = new Map<Platform, Project>()
  const walk = (current: string, depth: number) => {
    const entries = read(current)
    if (entries.length === 0) return
    const names = new Set(entries.map((entry) => entry.name))
    const framework = detectFramework(current, names)
    const expo = framework === "expo"
    const here = (platform: Platform, directory: string, needsPrebuild = false): Project => ({
      platform,
      directory,
      root: current,
      framework,
      needsPrebuild,
    })

    if (!found.has("ios") && process.platform === "darwin") {
      const native = entries.some((e) => e.name.endsWith(".xcodeproj") || e.name.endsWith(".xcworkspace"))
      if (native || names.has("Podfile")) found.set("ios", here("ios", current))
      else if (names.has("ios") && hasXcodeProject(path.join(current, "ios")))
        found.set("ios", here("ios", path.join(current, "ios")))
      else if (expo) found.set("ios", here("ios", current, true))
    }

    if (!found.has("android")) {
      if (GRADLE_MARKERS.some((marker) => names.has(marker))) found.set("android", here("android", current))
      else if (names.has("android") && hasGradleProject(path.join(current, "android")))
        found.set("android", here("android", path.join(current, "android")))
      else if (expo) found.set("android", here("android", current, true))
    }

    if (depth >= MAX_DEPTH) return
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith(".")) continue
      if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) continue
      walk(path.join(current, entry.name), depth + 1)
    }
  }
  walk(directory, 0)
  // A real native project always wins over an Expo app still needing prebuild.
  return [...found.values()].sort((a, b) => Number(a.needsPrebuild) - Number(b.needsPrebuild))
}

function read(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

function hasXcodeProject(directory: string) {
  return read(directory).some((entry) => entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))
}

function hasGradleProject(directory: string) {
  const names = new Set(read(directory).map((entry) => entry.name))
  return GRADLE_MARKERS.some((marker) => names.has(marker))
}

function isExpoApp(file: string) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null && "expo" in parsed
  } catch {
    return false
  }
}

/** Expo when configured as one, React Native when package.json depends on it, else native. */
function detectFramework(directory: string, names: Set<string>): Framework {
  const expo = names.has("app.json")
    ? isExpoApp(path.join(directory, "app.json"))
    : EXPO_CONFIGS.some((name) => names.has(name))
  const pkg = names.has("package.json") ? readPackage(directory) : undefined
  if (expo || !!pkg?.dependencies?.["expo"]) return "expo"
  if (pkg?.dependencies?.["react-native"]) return "react-native"
  return "native"
}

type Package = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

function readPackage(directory: string): Package | undefined {
  return parseJson<Package>(readText(path.join(directory, "package.json")))
}

function readText(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// ── long-running children ─────────────────────────────────────────────────────

// Runs the command, and when this process's stdin pipe closes (which happens even when the
// parent is SIGKILLed, as Electron does to its utility processes) tears the command's whole
// tree down. Without this every app restart leaves a preview server and Metro behind.
const GUARD = `
exec 3<&0
killtree() { for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c" "$2"; done; kill "-$2" "$1" 2>/dev/null; }
"$@" &
child=$!
# serve-avd stalls its graceful shutdown while a stream is connected, so escalate after a moment.
( cat <&3 >/dev/null; killtree "$child" TERM; sleep 2; killtree "$child" KILL ) &
watcher=$!
wait "$child"
code=$?
for c in $(pgrep -P "$watcher" 2>/dev/null); do kill "$c" 2>/dev/null; done
kill "$watcher" 2>/dev/null
exit "$code"
`

/** Wrap a long-running command so it dies with us. Spawn the result with stdin as a pipe. */
export function guarded(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") return { command, args }
  return { command: "/bin/sh", args: ["-c", GUARD, "guard", command, ...args] }
}

// ── prerequisites ─────────────────────────────────────────────────────────────

const METRO_PORT = 8081

/**
 * Whether `command` is on `searchPath`. Pass the login shell's PATH: the desktop app's own PATH
 * is the bare system one, without Homebrew, so `pod` and friends look missing from it.
 */
export function commandExists(command: string, searchPath = process.env["PATH"]) {
  if (whichIn(searchPath, command)) return true
  const probe = process.platform === "win32" ? "where" : "which"
  return (
    spawnSync(probe, [command], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PATH: searchPath ?? process.env["PATH"] ?? "" },
    }).status === 0
  )
}

/**
 * The tools a run needs before any build starts. Returns a one-line problem with the fix, so a
 * missing SDK fails in a second with something actionable instead of minutes into a build.
 */
export function preflight(project: Project, env?: Record<string, string>): string | undefined {
  const searchPath = env?.["PATH"] ?? process.env["PATH"]
  if (project.framework !== "native" && !existsSync(path.join(project.root, "node_modules")))
    return `Dependencies are not installed. Run \`npm install\` in ${project.root} and try again.`
  if (project.platform === "ios") {
    if (!commandExists("xcodebuild", searchPath))
      return "Xcode was not found. Install Xcode from the App Store, then run `xcode-select --install`."
    // Only a Podfile nobody has installed needs the tool; an installed one builds without it.
    const pods = project.needsPrebuild || !podsInstalled(project.directory)
    if (pods && !commandExists("pod", searchPath))
      return "CocoaPods is not installed. Run `brew install cocoapods` (or `sudo gem install cocoapods`) and try again."
    return
  }
  if (!androidSdk())
    return "Android SDK was not found. Install Android Studio, or set ANDROID_HOME to your SDK directory."
  if (!commandExists("java", searchPath))
    return "Java was not found. Install a JDK 17, for example `brew install --cask zulu@17`."
  if (!project.needsPrebuild && !gradleWrapper(project.directory)) return "No Gradle wrapper found in this project."
}

/** Gradle and the React Native plugin read the SDK location from the environment when there is no local.properties. */
export function androidEnv(): Record<string, string> {
  const sdk = androidSdk()
  if (!sdk || process.env["ANDROID_HOME"]) return {}
  return { ANDROID_HOME: sdk }
}

// ── Expo ──────────────────────────────────────────────────────────────────────

/**
 * `expo prebuild` prompts for the bundle identifier and package name when app.json has none, and
 * refuses to continue without a TTY. Fill in the same defaults the prompt would suggest so a fresh
 * `create-expo-app` project runs without the user editing config first.
 */
export function ensureExpoAppIds(root: string, platform: Platform): string | undefined {
  const file = path.join(root, "app.json")
  const text = readText(file)
  if (!text) return
  const parsed = parseJson<{ expo?: Record<string, unknown> }>(text)
  const expo = parsed?.expo
  if (!expo) return
  const key = platform === "ios" ? "ios" : "android"
  const field = platform === "ios" ? "bundleIdentifier" : "package"
  const section = (typeof expo[key] === "object" && expo[key] !== null ? expo[key] : {}) as Record<string, unknown>
  if (typeof section[field] === "string") return
  const slug = typeof expo["slug"] === "string" ? expo["slug"] : typeof expo["name"] === "string" ? expo["name"] : "app"
  const cleaned = slug.replace(/[^A-Za-z0-9]+/g, "").toLowerCase() || "app"
  section[field] = `com.anonymous.${cleaned}`
  expo[key] = section
  const indent = /^\s*\{\r?\n(\s+)"/.exec(text)?.[1] ?? "  "
  writeFileSync(file, JSON.stringify(parsed, null, indent) + "\n")
  return `Set expo.${key}.${field} to ${String(section[field])} in app.json`
}

/** Native project directory produced by `expo prebuild` for one platform. */
export function prebuiltDirectory(root: string, platform: Platform) {
  const directory = path.join(root, platform)
  const ready = platform === "ios" ? hasXcodeProject(directory) : hasGradleProject(directory)
  return ready ? directory : undefined
}

/** True when there is no Podfile, or it has been installed at least once. */
export function podsInstalled(directory: string) {
  if (!existsSync(path.join(directory, "Podfile"))) return true
  return existsSync(path.join(directory, "Pods", "Manifest.lock"))
}

// ── ports ─────────────────────────────────────────────────────────────────────

/**
 * First port at or above `start` that nothing on loopback is listening on. Preview servers from
 * other tools, or orphaned from an earlier opencode process, routinely hold the defaults.
 */
export async function freePort(start: number, span = 50) {
  for (let port = start; port < start + span; port += 1) {
    if (await available(port)) return port
  }
  return undefined
}

function available(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", () => resolve(false))
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)))
  })
}

// ── Node ──────────────────────────────────────────────────────────────────────

export type Version = readonly [number, number, number]

export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compare(a: Version, b: Version) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return 0
}

const formatVersion = (version: Version) => `v${version.join(".")}`

/**
 * Enough of node-semver for `engines.node`: comparators, caret and tilde, x-ranges, and `||`.
 * Anything it cannot read is treated as satisfied rather than blocking a build.
 */
export function satisfies(version: Version, range: string) {
  return range.split("||").some((alternative) =>
    alternative
      .trim()
      // ">= 25.0.0" is one comparator, not an operator and a version.
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => comparator(version, part)),
  )
}

function comparator(version: Version, part: string) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(part)
  if (!match) return true
  const op = match[1] ?? ""
  const major = Number(match[2])
  const minor = match[3] === undefined || match[3] === "x" || match[3] === "*" ? undefined : Number(match[3])
  const patch = match[4] === undefined || match[4] === "x" || match[4] === "*" ? undefined : Number(match[4])
  const low: Version = [major, minor ?? 0, patch ?? 0]
  // First version above everything the partial version covers: 20 → 21.0.0, 20.19 → 20.20.0.
  const next: Version = minor === undefined ? [major + 1, 0, 0] : patch === undefined ? [major, minor + 1, 0] : low
  switch (op) {
    case ">=":
      return compare(version, low) >= 0
    case ">":
      return patch === undefined ? compare(version, next) >= 0 : compare(version, low) > 0
    case "<":
      return compare(version, low) < 0
    case "<=":
      return patch === undefined ? compare(version, next) < 0 : compare(version, low) <= 0
    case "^": {
      const upper: Version =
        major > 0 ? [major + 1, 0, 0] : (minor ?? 0) > 0 ? [0, (minor ?? 0) + 1, 0] : [0, minor ?? 0, (patch ?? 0) + 1]
      return compare(version, low) >= 0 && compare(version, upper) < 0
    }
    case "~":
      return (
        compare(version, low) >= 0 &&
        compare(version, minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0]) < 0
      )
    default:
      return patch === undefined
        ? compare(version, low) >= 0 && compare(version, next) < 0
        : compare(version, low) === 0
  }
}

const NODE_MANIFESTS = [
  "package.json",
  "node_modules/react-native/package.json",
  "node_modules/expo/package.json",
  "node_modules/@expo/cli/package.json",
]

/** Every `engines.node` range the project and its mobile toolchain declare. All must hold. */
export function nodeRequirement(root: string) {
  return NODE_MANIFESTS.flatMap((file) => {
    const range = parseJson<{ engines?: { node?: string } }>(readText(path.join(root, file)))?.engines?.node
    return typeof range === "string" && range.trim() ? [range.trim()] : []
  })
}

function whichIn(searchPath: string | undefined, command: string) {
  const name = process.platform === "win32" ? `${command}.exe` : command
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
}

/** Bin directories of Node installs from the usual version managers and Homebrew, if present. */
export function nodeInstalls() {
  const home = os.homedir()
  const roots = [
    { dir: process.env["NVM_DIR"] ?? path.join(home, ".nvm"), sub: ["versions", "node"], bin: "bin" },
    {
      dir: process.env["FNM_DIR"] ?? path.join(home, ".local", "share", "fnm"),
      sub: ["node-versions"],
      bin: "installation/bin",
    },
    { dir: path.join(home, "Library", "Application Support", "fnm"), sub: ["node-versions"], bin: "installation/bin" },
    { dir: path.join(home, ".volta", "tools", "image", "node"), sub: [], bin: "bin" },
    { dir: process.env["ASDF_DATA_DIR"] ?? path.join(home, ".asdf"), sub: ["installs", "nodejs"], bin: "bin" },
  ]
  const found: string[] = []
  for (const root of roots) {
    const parent = path.join(root.dir, ...root.sub)
    for (const entry of read(parent)) {
      if (!entry.isDirectory()) continue
      const bin = path.join(parent, entry.name, root.bin)
      if (existsSync(path.join(bin, "node"))) found.push(bin)
    }
  }
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const entry of read(prefix)) {
      if (!/^node(@\d+)?$/.test(entry.name)) continue
      const bin = path.join(prefix, entry.name, "bin")
      if (existsSync(path.join(bin, "node"))) found.push(bin)
    }
  }
  return found
}

export type NodeChoice =
  | { readonly bin?: string; readonly version: Version; readonly note?: string }
  | { readonly problem: string }

/**
 * A Node that satisfies every range: the one already on PATH when it does, otherwise the newest
 * install a version manager or Homebrew has. `bin` is the directory to put first on PATH.
 */
export async function resolveNode(ranges: string[], env: Record<string, string | undefined>): Promise<NodeChoice> {
  const current = whichIn(env["PATH"], "node")
  const currentVersion = current ? parseVersion(await capture(current, ["--version"])) : undefined
  const ok = (version: Version) => ranges.every((range) => satisfies(version, range))
  if (currentVersion && ok(currentVersion)) return { version: currentVersion }

  const candidates: { bin: string; version: Version }[] = []
  for (const bin of nodeInstalls()) {
    const version =
      parseVersion(path.basename(path.dirname(bin.replace(/\/installation\/bin$/, "")))) ??
      parseVersion(await capture(path.join(bin, "node"), ["--version"]))
    if (version && ok(version)) candidates.push({ bin, version })
  }
  candidates.sort((a, b) => compare(b.version, a.version))
  const best = candidates[0]
  const needs = ranges.join(" and ")
  const have = currentVersion ? `Node ${formatVersion(currentVersion)} on PATH` : "no Node on PATH"
  if (best)
    return {
      bin: best.bin,
      version: best.version,
      note: `Using Node ${formatVersion(best.version)} from ${best.bin} (${have} does not satisfy ${needs})`,
    }
  return {
    problem: `This project needs Node ${needs}, but there is ${have} and no newer Node installed. Install one (for example \`nvm install 22\`) and try again.`,
  }
}

// ── Metro ─────────────────────────────────────────────────────────────────────

export function metroPort() {
  const value = Number(process.env["RCT_METRO_PORT"])
  return Number.isInteger(value) && value > 0 ? value : METRO_PORT
}

export function metroUrl(port = metroPort()) {
  return `http://localhost:${port}`
}

/** Metro (React Native CLI and Expo alike) answers /status with `packager-status:running` once ready. */
export async function metroRunning(port = metroPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    return (await response.text()).includes("packager-status:running")
  } catch {
    return false
  }
}

/** Process listening on a loopback port and its working directory, via lsof (POSIX only). */
export async function portOwner(port: number): Promise<{ pid: number; cwd?: string } | undefined> {
  if (process.platform === "win32") return undefined
  const pid = Number(
    (await capture("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]))
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line)),
  )
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const cwd = parseLsofCwd(await capture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))
  return { pid, cwd }
}

/** `lsof -Fn` prints one field per line: `p<pid>`, `fcwd`, `n<path>`. */
export function parseLsofCwd(output: string) {
  return output
    .split("\n")
    .find((line) => line.startsWith("n/"))
    ?.slice(1)
}

export function bundlerCommand(framework: Framework, port = metroPort()): { command: string; args: string[] } {
  if (framework === "expo") return { command: "npx", args: ["expo", "start", "--dev-client", "--port", String(port)] }
  return { command: "npx", args: ["react-native", "start", "--port", String(port)] }
}

// ── iOS ───────────────────────────────────────────────────────────────────────

export type IosTarget = {
  readonly container: string[]
  readonly scheme: string
  readonly bundleID: string
  readonly app: string
}

/** Resolve the scheme, built product and bundle id for an Xcode project. */
export async function iosTarget(directory: string): Promise<IosTarget | string> {
  const entries = read(directory)
  const workspace = entries.find((entry) => entry.name.endsWith(".xcworkspace"))
  const project = entries.find((entry) => entry.name.endsWith(".xcodeproj"))
  const container = workspace
    ? ["-workspace", path.join(directory, workspace.name)]
    : project
      ? ["-project", path.join(directory, project.name)]
      : undefined
  if (!container) return "No Xcode project or workspace found."

  const listed = await capture("xcodebuild", [...container, "-list", "-json"], { cwd: directory })
  const schemes = parseJson<{ project?: { schemes?: string[] }; workspace?: { schemes?: string[] } }>(listed)
  const scheme = pickScheme(
    schemes?.project?.schemes ?? schemes?.workspace?.schemes ?? [],
    (workspace ?? project)!.name,
  )
  if (!scheme) return "No shared scheme found in the Xcode project."

  const settingsOutput = await capture(
    "xcodebuild",
    [
      ...container,
      "-scheme",
      scheme,
      "-sdk",
      "iphonesimulator",
      "-configuration",
      "Debug",
      "-showBuildSettings",
      "-json",
    ],
    { cwd: directory },
  )
  const settings = parseJson<{ buildSettings?: Record<string, string> }[]>(settingsOutput)?.[0]?.buildSettings
  const bundleID = settings?.["PRODUCT_BUNDLE_IDENTIFIER"]
  const products = settings?.["BUILT_PRODUCTS_DIR"]
  const product = settings?.["FULL_PRODUCT_NAME"]
  if (!bundleID || !products || !product) return "Could not read the Xcode build settings for this scheme."
  return { container, scheme, bundleID, app: path.join(products, product) }
}

// CocoaPods workspaces list Pods-* schemes next to the app: prefer the one named like the container.
function pickScheme(schemes: string[], container: string) {
  const name = container.replace(/\.(xcworkspace|xcodeproj)$/, "")
  return (
    schemes.find((scheme) => scheme === name) ??
    schemes.find((scheme) => !scheme.startsWith("Pods") && !scheme.includes("Tests")) ??
    schemes[0]
  )
}

export function iosBuildArgs(target: IosTarget, udid: string) {
  return [
    ...target.container,
    "-scheme",
    target.scheme,
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,id=${udid}`,
    "-sdk",
    "iphonesimulator",
    "build",
  ]
}

/** UDID of the booted simulator, if any. */
export async function bootedSimulator() {
  const output = await capture("xcrun", ["simctl", "list", "devices", "booted", "-j"])
  const parsed = parseJson<{ devices?: Record<string, { udid: string; state: string }[]> }>(output)
  for (const devices of Object.values(parsed?.devices ?? {})) {
    const booted = devices.find((device) => device.state === "Booted")
    if (booted) return booted.udid
  }
  return undefined
}

// ── Android ───────────────────────────────────────────────────────────────────

export function androidSdk() {
  const candidates = [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ]
  return candidates.find((candidate) => !!candidate && existsSync(candidate))
}

export function adb() {
  const sdk = androidSdk()
  const bundled = sdk && path.join(sdk, "platform-tools", "adb")
  return bundled && existsSync(bundled) ? bundled : "adb"
}

function aapt2() {
  const sdk = androidSdk()
  if (!sdk) return
  const root = path.join(sdk, "build-tools")
  const versions = read(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const version of versions) {
    const candidate = path.join(root, version, "aapt2")
    if (existsSync(candidate)) return candidate
  }
}

/** Serial of the first attached device, if any. */
export async function androidDevice() {
  const output = await capture(adb(), ["devices"])
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .find((parts) => parts[1]?.trim() === "device")?.[0]
}

/** Primary CPU ABI of a device, e.g. `arm64-v8a`. */
export async function androidAbi(serial: string) {
  const output = await capture(adb(), ["-s", serial, "shell", "getprop", "ro.product.cpu.abi"])
  const abi = output.trim()
  return /^[a-z0-9_-]+$/i.test(abi) ? abi : undefined
}

/** Free space on the device's data partition in megabytes, when `df` reports it. */
export async function androidFreeMb(serial: string) {
  return parseFreeMb(await capture(adb(), ["-s", serial, "shell", "df", "-k", "/data"]))
}

/** Second line of `df -k`: Filesystem 1K-blocks Used Available Use% Mounted. */
export function parseFreeMb(output: string) {
  const row = output.trim().split("\n")[1]?.trim().split(/\s+/)
  const available = Number(row?.[3])
  return Number.isFinite(available) && available >= 0 ? Math.round(available / 1024) : undefined
}

/** The reason adb gives for a failed install, e.g. `INSTALL_FAILED_INSUFFICIENT_STORAGE`. */
export function installFailure(log: ReadonlyArray<string>) {
  for (const line of [...log].reverse()) {
    const match = /Failure \[([^\]]+)\]/.exec(line)
    if (match) return match[1]
  }
}

/**
 * React Native's Gradle plugin builds every ABI listed in `reactNativeArchitectures`. A debug
 * build for one known device only needs its own, which cuts build time and the APK by about 3x.
 */
export function reactNativeArchitectureArgs(abi: string | undefined) {
  return abi ? [`-PreactNativeArchitectures=${abi}`] : []
}

export function gradleWrapper(directory: string) {
  const wrapper = path.join(directory, process.platform === "win32" ? "gradlew.bat" : "gradlew")
  return existsSync(wrapper) ? wrapper : undefined
}

/** Application module name from settings.gradle, defaulting to `app`. */
export function androidModule(directory: string) {
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    const file = path.join(directory, name)
    if (!existsSync(file)) continue
    const includes = [...readFileSync(file, "utf8").matchAll(/include\s*\(?\s*["']:?([A-Za-z0-9_\-.]+)["']/g)].map(
      (match) => match[1],
    )
    if (includes.includes("app")) return "app"
    const first = includes[0]
    if (first) return first
  }
  return "app"
}

export function androidApk(directory: string, module: string) {
  const outputs = path.join(directory, module, "build", "outputs", "apk", "debug")
  const apk = read(outputs)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".apk"))
    .sort((a, b) => a.name.length - b.name.length)[0]
  return apk ? path.join(outputs, apk.name) : undefined
}

export type AndroidApp = { readonly id: string; readonly activity?: string }

/** Package name and launch activity, read from the built APK when possible. */
export async function androidApp(apk: string, directory: string, module: string): Promise<AndroidApp | undefined> {
  const tool = aapt2()
  if (tool) {
    const badging = await capture(tool, ["dump", "badging", apk])
    const id = /package: name='([^']+)'/.exec(badging)?.[1]
    const activity = /launchable-activity: name='([^']+)'/.exec(badging)?.[1]
    if (id) return { id, activity }
  }
  // Fallback for SDKs without build-tools: read the Gradle config directly.
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const file = path.join(directory, module, name)
    if (!existsSync(file)) continue
    const source = readFileSync(file, "utf8")
    const id = /applicationId\s*=?\s*["']([^"']+)["']/.exec(source)?.[1]
    if (!id) continue
    const suffix = /applicationIdSuffix\s*=?\s*["']([^"']+)["']/.exec(source)?.[1] ?? ""
    return { id: id + suffix }
  }
}

function parseJson<T>(value: string): T | undefined {
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value) as T | undefined
  } catch {
    return undefined
  }
}
