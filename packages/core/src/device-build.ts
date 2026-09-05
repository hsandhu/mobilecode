export * as DeviceBuild from "./device-build"

import { spawn, spawnSync, type ChildProcess } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
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
  const child = spawn(command, args, {
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
export async function capture(command: string, args: string[], options: { cwd?: string } = {}) {
  const out: string[] = []
  const running = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
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
  /** True when the directory is an Expo app with no native project generated yet. */
  readonly needsPrebuild: boolean
}

export type Platform = "ios" | "android"

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
    const expo = names.has("app.json") ? isExpoApp(path.join(current, "app.json")) : EXPO_CONFIGS.some((n) => names.has(n))

    if (!found.has("ios") && process.platform === "darwin") {
      const native = entries.some((e) => e.name.endsWith(".xcodeproj") || e.name.endsWith(".xcworkspace"))
      if (native || names.has("Podfile")) found.set("ios", { platform: "ios", directory: current, needsPrebuild: false })
      else if (names.has("ios") && hasXcodeProject(path.join(current, "ios")))
        found.set("ios", { platform: "ios", directory: path.join(current, "ios"), needsPrebuild: false })
      else if (expo) found.set("ios", { platform: "ios", directory: current, needsPrebuild: true })
    }

    if (!found.has("android")) {
      if (GRADLE_MARKERS.some((marker) => names.has(marker)))
        found.set("android", { platform: "android", directory: current, needsPrebuild: false })
      else if (names.has("android") && hasGradleProject(path.join(current, "android")))
        found.set("android", { platform: "android", directory: path.join(current, "android"), needsPrebuild: false })
      else if (expo) found.set("android", { platform: "android", directory: current, needsPrebuild: true })
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
  const scheme = schemes?.project?.schemes?.[0] ?? schemes?.workspace?.schemes?.[0]
  if (!scheme) return "No shared scheme found in the Xcode project."

  const settingsOutput = await capture(
    "xcodebuild",
    [...container, "-scheme", scheme, "-sdk", "iphonesimulator", "-configuration", "Debug", "-showBuildSettings", "-json"],
    { cwd: directory },
  )
  const settings = parseJson<{ buildSettings?: Record<string, string> }[]>(settingsOutput)?.[0]?.buildSettings
  const bundleID = settings?.["PRODUCT_BUNDLE_IDENTIFIER"]
  const products = settings?.["BUILT_PRODUCTS_DIR"]
  const product = settings?.["FULL_PRODUCT_NAME"]
  if (!bundleID || !products || !product) return "Could not read the Xcode build settings for this scheme."
  return { container, scheme, bundleID, app: path.join(products, product) }
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
