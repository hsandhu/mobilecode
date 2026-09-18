export * as DevicePreview from "./device-preview"

import { DevicePreview } from "@opencode-ai/schema/device-preview"
import { Context, Effect, Layer } from "effect"
import type { ChildProcess } from "child_process"
import type { Readable } from "stream"
import launch from "cross-spawn"
import os from "os"
import path from "path"
import { DeviceBuild } from "./device-build"
import { makeGlobalNode } from "./effect/app-node"
import { Shell } from "./shell"

export const Platform = DevicePreview.Platform
export type Platform = DevicePreview.Platform
export const Server = DevicePreview.Server
export type Server = DevicePreview.Server
export const Build = DevicePreview.Build
export type Build = DevicePreview.Build
export const Info = DevicePreview.Info
export type Info = DevicePreview.Info
export const Framework = DevicePreview.Framework
export type Framework = DevicePreview.Framework
export const Bundler = DevicePreview.Bundler
export type Bundler = DevicePreview.Bundler

export type Target = { readonly directory: string; readonly platform: Platform }

export interface Interface {
  readonly detect: (input: { directory: string }) => Effect.Effect<Platform[]>
  readonly info: (input: { directory: string }) => Effect.Effect<Info>
  readonly start: (input: {
    directory: string
    platform: Platform
    env?: Record<string, string>
  }) => Effect.Effect<Info>
  readonly stop: (input: Target) => Effect.Effect<Info>
  readonly startBundler: (input: { directory: string; env?: Record<string, string> }) => Effect.Effect<Info>
  readonly stopBundler: (input: { directory: string }) => Effect.Effect<Info>
  /** Start and stream a virtual device, then build, install and launch this location's app. */
  readonly runApp: (input: {
    directory: string
    platform: Platform
    env?: Record<string, string>
    /** Launch the app installed by the previous run when it is still on the device. */
    relaunch?: boolean
  }) => Effect.Effect<Info>
  /** Cancel the build, terminate the app, close its stream and shut down its virtual device. */
  readonly stopApp: (input: Target) => Effect.Effect<Info>
  /** Compatibility endpoint: switching locations only reads status; running is always explicit. */
  readonly focus: (input: { directory: string; env?: Record<string, string> }) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DevicePreview") {}

// serve-sim (iOS Simulator) and serve-avd (Android Emulator) both serve a browser preview UI and
// print its origin to stdout once the port is bound. Both default to 3200 and exit when it is
// taken, so each gets the first free port in its own range and the two can run side by side.
const COMMANDS: Record<Platform, { command: string; args: (port: number) => string[] }> = {
  ios: { command: "npx", args: (port) => ["--yes", "serve-sim", "--port", String(port)] },
  android: { command: "npx", args: (port) => ["--yes", "serve-avd", "--port", String(port)] },
}
const PORTS: Record<Platform, number> = { ios: 3200, android: 3250 }
const LOG_LIMIT = 200
const STOP_TIMEOUT_MS = 3000
const DEVICE_WAIT_MS = 180_000
const BUNDLER_WAIT_MS = 90_000
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const PREVIEW_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

type ServerState = {
  platform: Platform
  status: DevicePreview.Status
  command: string
  url?: string
  pid?: number
  exitCode?: number
  log: string[]
}

type Active = {
  state: ServerState
  directory: string
  device: string
  process?: ChildProcess
}

type BuildState = {
  platform: Platform
  framework?: Framework
  status: DevicePreview.BuildStatus
  directory?: string
  target?: string
  appID?: string
  step?: string
  error?: string
  log: string[]
  startedAt?: number
  finishedAt?: number
}

type ActiveBuild = {
  directory: string
  state: BuildState
  process?: ChildProcess
  deviceProcess?: ChildProcess
  preview?: Active
  cancelled: boolean
  /** Settles when the detached pipeline has fully unwound, so a stop can wait for it. */
  done?: Promise<void>
  /** Simulator UDID or adb serial the app was installed on. */
  device?: string
  /** JavaScript root whose Metro bundler this app depends on. */
  root?: string
  /** What the last successful run put on `device`, so a later run can relaunch without building. */
  installed?: Installed
}

type Installed = { readonly appID: string; readonly activity?: string }

type BundlerState = {
  framework: Framework
  directory: string
  status: DevicePreview.Status
  command: string
  url?: string
  pid?: number
  exitCode?: number
  log: string[]
}

type ActiveBundler = {
  state: BundlerState
  process?: ChildProcess
  /** A user-started Metro stays up when the last native app is stopped. */
  manual: boolean
  /** Settles once Metro answers or the process gives up; never rejects. */
  ready: Promise<void>
}

const BUSY: DevicePreview.BuildStatus[] = ["building", "installing", "launching"]
const buildPrefix = (directory: string) => `${directory}\0`
const buildKey = (input: Target) => `${buildPrefix(input.directory)}${input.platform}`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const servers = new Map<Platform, Active>()
    const builds = new Map<string, ActiveBuild>()
    const owners = new Map<Platform, ActiveBuild>()
    const transitions = new Map<Platform, Promise<void>>()
    // One Metro per JavaScript root, shared by the iOS and Android apps built from it.
    const bundlers = new Map<string, ActiveBundler>()

    // Nothing reaps the children when this process dies without unwinding the layer (a signal,
    // or process.exit from the CLI entrypoint), so ask them to stop from the process hooks too.
    const onExit = () => {
      for (const active of servers.values()) terminate(active.process, active.state.status === "exited")
      for (const bundler of bundlers.values()) terminate(bundler.process, bundler.state.status === "exited")
      for (const build of builds.values()) {
        terminate(build.process, false)
        terminate(build.deviceProcess, false)
      }
    }
    const onSignal = (signal: NodeJS.Signals) => {
      onExit()
      // Keep the default termination when nothing else handles the signal (signal-exit pattern).
      if (process.listenerCount(signal) > 1) return
      unhook()
      process.kill(process.pid, signal)
    }
    const hook = () => {
      if (process.listeners("exit").includes(onExit)) return
      process.on("exit", onExit)
      if (process.platform === "win32") return
      for (const signal of SIGNALS) process.on(signal, onSignal)
    }
    const unhook = () => {
      process.off("exit", onExit)
      for (const signal of SIGNALS) process.off(signal, onSignal)
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        unhook()
        for (const build of builds.values()) {
          build.cancelled = true
          terminate(build.process, false)
          terminate(build.deviceProcess, false)
        }
        builds.clear()
        await Promise.all([...servers.values(), ...bundlers.values()].map(kill))
        servers.clear()
        bundlers.clear()
      }),
    )

    const detect = Effect.fn("DevicePreview.detect")(function* (input: { directory: string }) {
      return DeviceBuild.findProjects(input.directory).map((project) => project.platform)
    })

    const info = Effect.fn("DevicePreview.info")(function* (input: { directory: string }) {
      const projects = DeviceBuild.findProjects(input.directory)
      const bundler = [...bundlers.values()].find((active) => within(active.state.directory, input.directory))
      return {
        platforms: projects.map((project) => project.platform),
        framework: projects[0]?.framework,
        bundler: bundler ? { ...bundler.state, log: [...bundler.state.log] } : undefined,
        servers: [...servers.values()]
          .filter((active) => active.directory === input.directory)
          .map((active) => ({ ...active.state, log: [...active.state.log] })),
        builds: [...builds.entries()]
          .filter(([key]) => key.startsWith(buildPrefix(input.directory)))
          .map(([, build]) => ({ ...build.state, device: build.device, log: [...build.state.log] })),
      }
    })

    const launchPreview = async (input: {
      directory: string
      platform: Platform
      device: string
      env?: Record<string, string>
      cancelled: () => boolean
    }) => {
      if (input.cancelled()) return
      const current = servers.get(input.platform)
      if (current && current.state.status !== "exited" && current.device === input.device) {
        current.directory = input.directory
        return current
      }
      if (current) await kill(current)
      if (input.cancelled()) return
      const spec = COMMANDS[input.platform]
      const state: ServerState = {
        platform: input.platform,
        status: "starting",
        command: [spec.command, ...spec.args(PORTS[input.platform])].join(" "),
        log: [],
      }
      // Claim the slot before the first await so a second caller cannot start a duplicate.
      const active: Active = { state, directory: input.directory, device: input.device }
      servers.set(input.platform, active)
      const port = await DeviceBuild.freePort(PORTS[input.platform])
      // A stop that landed during the lookup already removed the slot; spawning now would orphan.
      if (input.cancelled() || servers.get(input.platform) !== active) {
        state.status = "exited"
        return
      }
      if (!port) {
        push(state.log, `No free port found from ${PORTS[input.platform]} upward.`)
        state.status = "exited"
        return active
      }
      const args = [...spec.args(port), input.device]
      state.command = [spec.command, ...args].join(" ")
      // Same process group as the server so a terminal Ctrl+C reaches npx and serve-* as well.
      // stdin is the guard's lifeline: it closes when this process dies, however it dies.
      const wrapped = DeviceBuild.guarded(spec.command, args)
      const child = launch(wrapped.command, wrapped.args, {
        cwd: input.directory,
        env: { ...process.env, ...input.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      state.pid = child.pid
      active.process = child
      hook()
      const append = (line: string) => {
        const text = clean(line)
        if (!text) return
        push(state.log, text)
        if (state.status !== "starting") return
        const match = PREVIEW_URL.exec(text)
        if (!match) return
        state.url = match[0]
        state.status = "running"
      }
      lines(child.stdout, append)
      lines(child.stderr, append)
      child.once("error", (error) => {
        append(error.message)
        state.status = "exited"
        state.url = undefined
      })
      child.once("exit", (code) => {
        state.status = "exited"
        state.exitCode = code ?? undefined
        state.url = undefined
      })
      return active
    }

    // Pin one virtual device for boot, streaming, installation and shutdown.
    const ensureDevice = async (
      platform: Platform,
      directory: string,
      env: Record<string, string> | undefined,
      active: ActiveBuild,
      report: Report,
    ) => {
      const target = await DeviceBuild.deviceTarget(platform)
      if (active.cancelled || !target) return
      active.device = target.id
      report.step(platform === "ios" ? "Starting simulator" : "Starting emulator")
      let bootExited = false
      if (target.boot) {
        const boot = DeviceBuild.exec(target.boot.command, target.boot.args, { cwd: directory, env }, report.log)
        if (platform === "android") {
          active.deviceProcess = boot.child
          boot.child.once("error", (error) => report.log(error.message))
          void boot.exit.then(() => {
            bootExited = true
          })
        }
        if (platform === "ios") {
          active.process = boot.child
          const code = await boot.exit
          active.process = undefined
          if (active.cancelled || code !== 0) return
        }
      }
      const deadline = Date.now() + DEVICE_WAIT_MS
      while (Date.now() < deadline && !active.cancelled) {
        if (bootExited) {
          report.fail("The emulator exited before it finished booting. Open the build log for details.")
          return
        }
        if (await DeviceBuild.deviceReady(platform, target.id)) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (active.cancelled || Date.now() >= deadline) return
      // An already booted device still needs a stream (including after a prior stream failure).
      const server = await launchPreview({
        directory: active.directory,
        platform,
        device: target.id,
        env,
        cancelled: () => active.cancelled,
      })
      active.preview = server
      if (active.cancelled || !server) return
      while (Date.now() < deadline && !active.cancelled && server.state.status === "starting")
        await new Promise((resolve) => setTimeout(resolve, 200))
      if (active.cancelled || server.state.status !== "running") {
        report.fail(server.state.log.at(-1) ?? "Could not start the device preview stream.")
        return
      }
      return target.id
    }

    // Debug builds load their JavaScript from Metro at launch, so it must be up before the app is.
    // Start it as early as possible and let the build overlap with its warm-up.
    const ensureBundler = (root: string, framework: Framework, env: Record<string, string> | undefined) => {
      const current = bundlers.get(root)
      if (current && current.state.status !== "exited") return current
      const port = DeviceBuild.metroPort()
      const spec = DeviceBuild.bundlerCommand(framework, port)
      const state: BundlerState = {
        framework,
        directory: root,
        status: "starting",
        command: [spec.command, ...spec.args].join(" "),
        log: [],
      }
      const active: ActiveBundler = { state, manual: false, ready: Promise.resolve() }
      const conflict = [...bundlers.values()].find(
        (value) => value.state.directory !== root && value.state.status !== "exited",
      )
      if (conflict) {
        state.status = "exited"
        push(
          state.log,
          `Metro is serving ${conflict.state.directory}. Stop that project's Metro before starting this project.`,
        )
        bundlers.set(root, active)
        return active
      }
      const abandoned = () => bundlers.get(root) !== active || active.state.status === "exited"
      active.ready = (async () => {
        const node = await nodeEnvironment({ root, framework }, env)
        if (abandoned()) return
        if ("problem" in node) {
          state.status = "exited"
          push(state.log, node.problem)
          return
        }
        if (node.note) push(state.log, node.note)
        // Something (a terminal, an earlier session) may already be serving this port. Reuse it
        // rather than have Expo offer to pick another port that the app would not know about.
        const running = await DeviceBuild.metroRunning(port)
        // A stop can land during the port check. Do not spawn an untracked Metro afterwards.
        if (abandoned()) return
        if (running) {
          const owner = await DeviceBuild.portOwner(port)
          if (abandoned()) return
          // Never replace a different project's Metro or serve this app the wrong bundle.
          // Ours when started inside the project, or from a workspace root above it (not from
          // somewhere as broad as the home directory).
          const ours =
            owner?.cwd &&
            (within(owner.cwd, root) || (within(root, owner.cwd) && owner.cwd !== "/" && owner.cwd !== os.homedir()))
          if (ours) {
            state.command = `Metro already running on port ${port}`
            state.url = DeviceBuild.metroUrl(port)
            state.pid = owner?.pid
            state.status = "running"
            return
          }
          push(
            state.log,
            owner?.cwd
              ? `Metro is serving ${owner.cwd}. Stop that project's Metro before starting this project.`
              : `Metro is already running on port ${port}, but its project could not be verified. Stop it before starting this project.`,
          )
          state.status = "exited"
          return
        }
        if (abandoned()) return
        const wrapped = DeviceBuild.guarded(spec.command, spec.args)
        const child = launch(wrapped.command, wrapped.args, {
          cwd: root,
          // Not CI mode: Expo disables file watching and reloads under CI=1.
          env: { ...process.env, ...node.env, EXPO_NO_TELEMETRY: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
        active.process = child
        state.pid = child.pid
        hook()
        const append = (line: string) => {
          const text = clean(line)
          if (text) push(state.log, text)
        }
        lines(child.stdout, append)
        lines(child.stderr, append)
        child.once("error", (error) => {
          append(error.message)
          state.status = "exited"
          state.url = undefined
        })
        child.once("exit", (code) => {
          state.status = "exited"
          state.exitCode = code ?? undefined
          state.url = undefined
        })
        const deadline = Date.now() + BUNDLER_WAIT_MS
        while (Date.now() < deadline && state.status === "starting") {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          if (state.status !== "starting") break
          if (await DeviceBuild.metroRunning(port)) {
            if (abandoned()) return
            state.url = DeviceBuild.metroUrl(port)
            state.status = "running"
          }
        }
        if (state.status === "starting") {
          push(state.log, "Metro did not become ready before the startup timeout.")
          await kill(active)
          state.status = "exited"
        }
      })().catch((error: unknown) => {
        push(state.log, error instanceof Error ? error.message : String(error))
        state.status = "exited"
      })
      bundlers.set(root, active)
      return active
    }

    // Only the last app to leave turns Metro off.
    const releaseBundler = async (root: string | undefined) => {
      if (!root) return
      const others = [...builds.values()].some(
        (build) => build.root === root && (BUSY.includes(build.state.status) || build.state.status === "running"),
      )
      if (others) return
      const active = bundlers.get(root)
      if (!active || active.manual) return
      bundlers.delete(root)
      await kill(active)
    }

    const startBundler = Effect.fn("DevicePreview.startBundler")(function* (input: {
      directory: string
      env?: Record<string, string>
    }) {
      const project = DeviceBuild.findProjects(input.directory).find((candidate) => candidate.framework !== "native")
      if (!project) return yield* info(input)
      ensureBundler(project.root, project.framework, input.env).manual = true
      return yield* info(input)
    })

    const stopBundler = Effect.fn("DevicePreview.stopBundler")(function* (input: { directory: string }) {
      const matches = [...bundlers.values()].filter((active) => within(active.state.directory, input.directory))
      yield* Effect.promise(async () => {
        for (const active of matches) {
          if (active.process) {
            await kill(active)
          } else if (active.state.pid && active.state.status !== "exited") {
            try {
              process.kill(active.state.pid, "SIGTERM")
            } catch {}
          }
          active.state.status = "exited"
          active.state.url = undefined
        }
      })
      return yield* info(input)
    })

    const runApp = Effect.fn("DevicePreview.runApp")(function* (input: {
      directory: string
      platform: Platform
      env?: Record<string, string>
      relaunch?: boolean
    }) {
      const key = buildKey(input)
      const existing = builds.get(key)
      if (existing && BUSY.includes(existing.state.status)) return yield* info(input)
      const previous = input.relaunch && existing ? { ...existing } : undefined
      const owner = owners.get(input.platform)
      if (owner) {
        owner.cancelled = true
        terminate(owner.process, false)
      }
      const active: ActiveBuild = {
        directory: input.directory,
        state: {
          platform: input.platform,
          status: "building",
          step: "Preparing",
          log: [],
          startedAt: Date.now(),
        },
        cancelled: false,
      }
      builds.set(key, active)
      owners.set(input.platform, active)
      hook()
      // Serialize ownership changes, but never hold the queue for an entire build: Stop must
      // be able to cancel it. Claim the build before yielding so double-clicks cannot duplicate it.
      active.done = transition(input.platform, async () => {
        if (owner) await halt(owner)
      })
        .then(() => {
          if (active.cancelled) return
          return execute(active, input.directory, input.platform, input.env, {
            ensureDevice,
            ensureBundler,
            previous,
          })
        })
        .catch((error: unknown) => {
          if (active.cancelled) return
          active.state.status = "failed"
          active.state.error = error instanceof Error ? error.message : String(error)
          active.state.step = undefined
          active.state.finishedAt = Date.now()
        })
      return yield* info(input)
    })

    // Cancel a build or terminate the app, then wait for the pipeline to unwind so a following
    // play cannot start another xcodebuild or Gradle on the same project.
    const halt = async (active: ActiveBuild) => {
      active.cancelled = true
      const proc = active.process
      active.process = undefined
      if (proc) terminate(proc, false)
      terminate(active.deviceProcess, false)
      await settle(active, proc)
      await quit(active)
      const server = servers.get(active.state.platform)
      if (server && server === active.preview) {
        servers.delete(active.state.platform)
        await kill(server)
      }
      if (active.device) await DeviceBuild.shutdownDevice(active.state.platform, active.device)
      active.device = undefined
      active.deviceProcess = undefined
      active.preview = undefined
      active.state.status = "idle"
      active.state.step = undefined
      active.state.finishedAt = Date.now()
      await releaseBundler(active.root)
    }

    const transition = (platform: Platform, task: () => Promise<void>) => {
      const next = (transitions.get(platform) ?? Promise.resolve()).then(task)
      transitions.set(
        platform,
        next.catch(() => {}),
      )
      return next
    }

    const stopApp = Effect.fn("DevicePreview.stopApp")(function* (input: Target) {
      const active = builds.get(buildKey(input))
      if (!active) return yield* info(input)
      active.cancelled = true
      if (active.process) terminate(active.process, false)
      yield* Effect.promise(() => transition(input.platform, () => halt(active)))
      return yield* info(input)
    })

    const focus = Effect.fn("DevicePreview.focus")(function* (input: {
      directory: string
      env?: Record<string, string>
    }) {
      return yield* info(input)
    })

    return Service.of({ detect, info, start: runApp, stop: stopApp, startBundler, stopBundler, runApp, stopApp, focus })
  }),
)

/** Wait for a cancelled pipeline to unwind, killing its child outright if it does not. */
async function settle(active: ActiveBuild, proc: ChildProcess | undefined) {
  if (!active.done) return
  const finished = await Promise.race([
    active.done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ])
  if (finished || !proc) return
  for (const pid of [...descendants(proc.pid), ...(proc.pid ? [proc.pid] : [])]) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
}

/** Build, install and launch. Runs detached from the request that started it. */
async function execute(
  active: ActiveBuild,
  directory: string,
  platform: Platform,
  env: Record<string, string> | undefined,
  runtime: Runtime,
) {
  const log = (line: string) => {
    const text = clean(line)
    if (text) push(active.state.log, text)
  }
  const fail = (message: string) => {
    if (active.cancelled) return
    active.state.status = "failed"
    active.state.step = undefined
    active.state.error = message
    active.state.finishedAt = Date.now()
  }
  const step = (value: string, status?: DevicePreview.BuildStatus) => {
    active.state.step = value
    if (status) active.state.status = status
  }

  try {
    let project = DeviceBuild.findProjects(directory).find((candidate) => candidate.platform === platform)
    if (!project) return fail(`No ${platform === "ios" ? "iOS" : "Android"} project found in this directory.`)
    const problem = DeviceBuild.preflight(project, env)
    if (problem) return fail(problem)
    active.state.framework = project.framework
    active.root = project.root
    if (platform === "android") env = { ...DeviceBuild.androidEnv(), ...env }
    const report = { log, fail, step }

    // Expo and React Native pin a Node range; the login shell's default is often older. Find one
    // that fits and put it first on PATH for every step below, or stop before wasting a build.
    const node = await nodeEnvironment(project, env)
    if (active.cancelled) return
    if ("problem" in node) return fail(node.problem)
    env = node.env
    if (node.note) log(node.note)

    if (project.needsPrebuild) {
      const generated = await prebuild(active, project, env, report)
      if (active.cancelled || !generated) return
      project = generated
    }
    active.state.directory = project.directory

    // Metro next: its warm-up overlaps with the device boot and the native build, and the app
    // needs it at launch. After prebuild, so it never watches folders being rewritten underneath it.
    const bundler =
      project.framework === "native" ? undefined : runtime.ensureBundler(project.root, project.framework, env)
    if (bundler?.state.status === "exited")
      return fail(bundler.state.log.at(-1) ?? "Metro did not start. Open the log for details.")

    const device = await runtime.ensureDevice(platform, project.directory, env, active, report)
    if (active.cancelled) return
    if (!device && active.state.status !== "failed")
      return fail(
        platform === "ios"
          ? "Could not start an iOS simulator. Check that an iOS simulator is available in Xcode."
          : "Could not start an emulator. Create an AVD in Android Studio and check the build log.",
      )
    if (!device) return
    active.device = device

    // Same device, app still installed from last time: bring it back without a build. Anything
    // wrong with that (uninstalled, wiped emulator) falls through to the full pipeline.
    const previous = runtime.previous
    if (previous?.installed && previous.device === device) {
      active.state.target = previous.state.target
      active.state.appID = previous.installed.appID
      const launched = await relaunch(active, platform, device, previous.installed, report, bundler)
      if (active.cancelled || launched) return
      report.log("Relaunch failed; rebuilding")
    }

    // Bare React Native ships a Podfile that nothing has installed yet on a fresh checkout.
    if (platform === "ios" && !DeviceBuild.podsInstalled(project.directory)) {
      report.step("Installing pods")
      const pods = DeviceBuild.exec("pod", ["install"], { cwd: project.directory, env }, report.log)
      active.process = pods.child
      const code = await pods.exit
      active.process = undefined
      if (active.cancelled) return
      if (code !== 0) return fail("`pod install` failed. Open the log for details.")
    }

    const beforeLaunch = bundler ? () => awaitBundler(bundler, report) : undefined
    if (platform === "ios") return await runIos(active, project.directory, env, report, device, beforeLaunch)
    return await runAndroid(
      active,
      project.directory,
      env,
      report,
      device,
      project.framework !== "native",
      beforeLaunch,
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

async function nodeEnvironment(
  project: Pick<DeviceBuild.Project, "root" | "framework">,
  env: Record<string, string> | undefined,
) {
  if (project.framework === "native") return { env }
  const ranges = DeviceBuild.nodeRequirement(project.root)
  if (ranges.length === 0) return { env }
  const node = await DeviceBuild.resolveNode(ranges, { ...process.env, ...env })
  if ("problem" in node) return node
  if (!node.bin) return { env, note: node.note }
  return {
    env: { ...env, PATH: `${node.bin}${path.delimiter}${env?.["PATH"] ?? process.env["PATH"] ?? ""}` },
    note: node.note,
  }
}

type Report = {
  log: (line: string) => void
  fail: (message: string) => void
  step: (value: string, status?: DevicePreview.BuildStatus) => void
}

type EnsureDevice = (
  platform: Platform,
  directory: string,
  env: Record<string, string> | undefined,
  active: ActiveBuild,
  report: Report,
) => Promise<string | undefined>

type Runtime = {
  ensureDevice: EnsureDevice
  ensureBundler: (root: string, framework: Framework, env: Record<string, string> | undefined) => ActiveBundler
  /** The build this one replaces, when the caller would rather relaunch its app than rebuild. */
  previous?: ActiveBuild
}

/** Called right before the app launches; returns false after reporting a failure. */
type BeforeLaunch = () => Promise<boolean>

/** Generate the native project for an Expo app in place. Returns the project to build from. */
async function prebuild(
  active: ActiveBuild,
  project: DeviceBuild.Project,
  env: Record<string, string> | undefined,
  report: Report,
): Promise<DeviceBuild.Project | undefined> {
  const note = DeviceBuild.ensureExpoAppIds(project.root, project.platform)
  if (note) report.log(note)
  report.step("Generating native project")
  const run = DeviceBuild.exec(
    "npx",
    ["expo", "prebuild", "--platform", project.platform],
    { cwd: project.root, env: { ...env, CI: "1", EXPO_NO_TELEMETRY: "1" } },
    report.log,
  )
  active.process = run.child
  const code = await run.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) {
    report.fail(buildError(active.state.log) ?? "`expo prebuild` failed. Open the log for details.")
    return
  }
  const directory = DeviceBuild.prebuiltDirectory(project.root, project.platform)
  if (!directory) {
    report.fail(`\`expo prebuild\` finished but produced no ${project.platform} project.`)
    return
  }
  return { ...project, directory, needsPrebuild: false }
}

async function awaitBundler(bundler: ActiveBundler, report: Report) {
  if (bundler.state.status === "starting") report.step("Waiting for Metro")
  await bundler.ready
  if (bundler.state.status === "running") return true
  const last =
    [...bundler.state.log].reverse().find((line) => /error|failed|EADDRINUSE|cannot/i.test(line)) ??
    bundler.state.log.at(-1)
  report.fail(last ? `Metro did not start: ${last.slice(0, 250)}` : "Metro did not start. Open the log for details.")
  return false
}

/** Launch the app a previous run installed. True on success, false to fall back to a build. */
async function relaunch(
  active: ActiveBuild,
  platform: Platform,
  device: string,
  installed: Installed,
  report: Report,
  bundler: ActiveBundler | undefined,
) {
  if (bundler && !(await awaitBundler(bundler, report))) return false
  if (active.cancelled) return false
  if (platform === "android" && bundler) {
    const reversed = await reverseMetro(active, device, report)
    if (active.cancelled || !reversed) return false
  }
  const ok =
    platform === "ios"
      ? await launchIos(active, device, installed.appID, report)
      : await launchAndroid(active, device, installed, report)
  if (!ok || active.cancelled) return false
  finish(active, installed)
  return true
}

async function launchIos(active: ActiveBuild, udid: string, bundleID: string, report: Report) {
  report.step("Launching", "launching")
  // A previous run may still be on screen; launching over it is not a restart, so end it first.
  await DeviceBuild.exec("xcrun", ["simctl", "terminate", udid, bundleID], {}).exit
  if (active.cancelled) return false
  const launched = DeviceBuild.exec("xcrun", ["simctl", "launch", udid, bundleID], {}, report.log)
  active.process = launched.child
  const code = await launched.exit
  active.process = undefined
  return code === 0
}

async function launchAndroid(active: ActiveBuild, serial: string, app: Installed, report: Report) {
  report.step("Launching", "launching")
  const args = app.activity
    ? ["-s", serial, "shell", "am", "start", "-n", `${app.appID}/${app.activity}`]
    : ["-s", serial, "shell", "monkey", "-p", app.appID, "-c", "android.intent.category.LAUNCHER", "1"]
  // `am start` reports a missing activity as "Error type 3" without a failing exit code.
  let errored = false
  const launched = DeviceBuild.exec(DeviceBuild.adb(), args, {}, (line) => {
    if (/^Error/.test(line.trim())) errored = true
    report.log(line)
  })
  active.process = launched.child
  const code = await launched.exit
  active.process = undefined
  return code === 0 && !errored
}

/** The emulator cannot see the host's localhost; route the Metro port through adb. */
async function reverseMetro(active: ActiveBuild, serial: string, report: Report) {
  const port = String(DeviceBuild.metroPort())
  const reverse = DeviceBuild.exec(
    DeviceBuild.adb(),
    ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`],
    {},
    report.log,
  )
  active.process = reverse.child
  const code = await reverse.exit
  active.process = undefined
  if (code !== 0) report.log(`adb reverse failed; the app may not reach Metro on port ${port}.`)
  return true
}

function finish(active: ActiveBuild, installed: Installed) {
  active.installed = installed
  active.state.status = "running"
  active.state.step = undefined
  active.state.error = undefined
  active.state.finishedAt = Date.now()
}

async function runIos(
  active: ActiveBuild,
  directory: string,
  env: Record<string, string> | undefined,
  report: Report,
  udid: string,
  beforeLaunch?: BeforeLaunch,
) {
  report.step("Reading project")
  const target = await DeviceBuild.iosTarget(directory)
  if (active.cancelled) return
  if (typeof target === "string") return report.fail(target)
  active.state.target = target.scheme
  active.state.appID = target.bundleID

  report.step(`Building ${target.scheme}`)
  const build = DeviceBuild.exec(
    "xcodebuild",
    DeviceBuild.iosBuildArgs(target, udid),
    { cwd: directory, env },
    report.log,
  )
  active.process = build.child
  const code = await build.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) return report.fail(buildError(active.state.log) ?? "Build failed.")

  report.step("Installing", "installing")
  const install = DeviceBuild.exec("xcrun", ["simctl", "install", udid, target.app], { cwd: directory }, report.log)
  active.process = install.child
  const installed = await install.exit
  active.process = undefined
  if (active.cancelled) return
  if (installed !== 0) return report.fail("Could not install the app on the simulator.")

  if (beforeLaunch && !(await beforeLaunch())) return
  if (active.cancelled) return
  const launched = await launchIos(active, udid, target.bundleID, report)
  if (active.cancelled) return
  if (!launched) return report.fail("Could not launch the app on the simulator.")
  finish(active, { appID: target.bundleID })
}

async function runAndroid(
  active: ActiveBuild,
  directory: string,
  env: Record<string, string> | undefined,
  report: Report,
  serial: string,
  reactNative: boolean,
  beforeLaunch?: BeforeLaunch,
) {
  const wrapper = DeviceBuild.gradleWrapper(directory)
  if (!wrapper) return report.fail("No Gradle wrapper found in this project.")
  const module = DeviceBuild.androidModule(directory)
  active.state.target = module

  // Only the device's own ABI for React Native: a universal debug APK is ~250 MB and routinely
  // fails to install on an emulator with a stock 6 GB data partition.
  const abi = reactNative ? await DeviceBuild.androidAbi(serial) : undefined
  if (active.cancelled) return
  if (abi) report.log(`Building for ${abi} only`)

  report.step(`Building ${module}`)
  const build = DeviceBuild.exec(
    wrapper,
    [`:${module}:assembleDebug`, ...DeviceBuild.reactNativeArchitectureArgs(abi)],
    { cwd: directory, env },
    report.log,
  )
  active.process = build.child
  const code = await build.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) return report.fail(buildError(active.state.log) ?? "Build failed.")

  const apk = DeviceBuild.androidApk(directory, module)
  if (!apk) return report.fail("Build finished but no debug APK was produced.")
  const app = await DeviceBuild.androidApp(apk, directory, module)
  if (active.cancelled) return
  if (!app) return report.fail("Could not determine the application id for this project.")
  active.state.appID = app.id

  report.step("Installing", "installing")
  const install = DeviceBuild.exec(
    DeviceBuild.adb(),
    ["-s", serial, "install", "-r", "-g", apk],
    { cwd: directory },
    report.log,
  )
  active.process = install.child
  const installed = await install.exit
  active.process = undefined
  if (active.cancelled) return
  if (installed !== 0) return report.fail(await installError(active.state.log, serial))

  if (beforeLaunch) {
    await reverseMetro(active, serial, report)
    if (active.cancelled) return
    if (!(await beforeLaunch())) return
    if (active.cancelled) return
  }
  const installedApp: Installed = { appID: app.id, ...(app.activity ? { activity: app.activity } : {}) }
  const launched = await launchAndroid(active, serial, installedApp, report)
  if (active.cancelled) return
  if (!launched) return report.fail("Could not launch the app on the device.")
  finish(active, installedApp)
}

/** Turn adb's install failure into something the user can act on. */
async function installError(log: ReadonlyArray<string>, serial: string) {
  const reason = DeviceBuild.installFailure(log)
  if (!reason) return "Could not install the APK on the device."
  if (reason.startsWith("INSTALL_FAILED_INSUFFICIENT_STORAGE")) {
    const free = await DeviceBuild.androidFreeMb(serial)
    const space = free === undefined ? "" : ` (${free} MB free)`
    return `The device is out of storage${space}. Uninstall apps or give the AVD a larger internal storage in Android Studio's Device Manager, then run again.`
  }
  return `Could not install the APK: ${reason}`
}

/** Ask the device to terminate the app that this build launched. */
async function quit(active: ActiveBuild) {
  const appID = active.state.appID
  const device = active.device
  if (!appID || !device) return
  if (active.state.platform === "ios") {
    await DeviceBuild.exec("xcrun", ["simctl", "terminate", device, appID], {}).exit
    return
  }
  await DeviceBuild.exec(DeviceBuild.adb(), ["-s", device, "shell", "am", "force-stop", appID], {}).exit
}

/** The most useful line from a failed build, for the status text and the toast. */
function buildError(log: string[]) {
  const lines = log.map((line) => line.trim())
  // Gradle prints the real cause under "* What went wrong:", usually prefixed with ">".
  const wrong = lines.findIndex((line) => line.includes("What went wrong"))
  if (wrong !== -1) {
    const detail = lines.slice(wrong + 1, wrong + 6).find((line) => line && !line.startsWith("*"))
    if (detail) return detail.replace(/^>\s*/, "").slice(0, 300)
  }
  const compiler = [...lines].reverse().find((line) => /(^|\s)error:/i.test(line))
  if (compiler) return compiler.slice(0, 300)
  return [...lines]
    .reverse()
    .find((line) => /FAILURE: Build failed/i.test(line))
    ?.slice(0, 300)
}

async function kill(active: { process?: ChildProcess; state: { status: DevicePreview.Status } }) {
  const proc = active.process
  if (!proc || active.state.status === "exited") return
  const exited = () => active.state.status === "exited"
  if (process.platform === "win32") return Shell.killTree(proc, { exited })
  // npm forwards SIGTERM to the serve-* process it launched, which shuts the stream down cleanly.
  // Capture the tree first so stragglers (simctl, adb) can still be force-killed afterwards.
  const tree = [...descendants(proc.pid), ...(proc.pid ? [proc.pid] : [])]
  proc.kill("SIGTERM")
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (!exited() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

/**
 * Synchronous best-effort stop, safe to call from the process `exit` event. npx does not always
 * forward the signal to the server it launched, and an orphaned serve-* keeps its port for days,
 * so signal the descendants as well.
 */
function terminate(proc: ChildProcess | undefined, exited: boolean) {
  if (!proc || exited) return
  if (process.platform === "win32") {
    proc.kill()
    return
  }
  for (const pid of descendants(proc.pid)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  proc.kill("SIGTERM")
}

// Direct and indirect child pids, deepest first. Only used on POSIX where pgrep is standard.
function descendants(pid: number | undefined): number[] {
  if (!pid) return []
  const result = DeviceBuild.spawnPgrep(pid)
  return result.flatMap((child) => [...descendants(child), child])
}

function within(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function clean(line: string) {
  return line.replace(ANSI, "").trimEnd()
}

function push(log: string[], line: string) {
  log.push(line)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

function lines(stream: Readable | null, onLine: (line: string) => void) {
  if (!stream) return
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    const parts = (rest + chunk).split(/\r?\n/)
    rest = parts.pop() ?? ""
    parts.forEach(onLine)
  })
  stream.on("end", () => {
    if (rest) onLine(rest)
  })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
