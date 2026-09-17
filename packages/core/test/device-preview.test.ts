import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { ChildProcess } from "child_process"
import path from "path"
import { Effect } from "effect"
import { DeviceBuild } from "@opencode-ai/core/device-build"
import { DevicePreview } from "@opencode-ai/core/device-preview"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { tmpdir } from "./fixture/tmpdir"

// Exercise the real lifecycle service and project detection; replace only host-tool boundaries
// so these tests never build, boot, or shut down a developer's real devices.
const calls: { command: string; args: string[]; cwd?: string }[] = []
const streams: string[][] = []
const shutdowns: string[] = []

beforeEach(() => {
  calls.length = 0
  streams.length = 0
  shutdowns.length = 0
  spyOn(DeviceBuild, "preflight").mockReturnValue(undefined)
  spyOn(DeviceBuild, "deviceTarget").mockImplementation(async (platform) => ({
    id: platform === "ios" ? "SIM-1" : "emulator-5554",
    boot: undefined,
  }))
  spyOn(DeviceBuild, "deviceReady").mockResolvedValue(true)
  spyOn(DeviceBuild, "shutdownDevice").mockImplementation(async (platform, id) => {
    shutdowns.push(`${platform}:${id}`)
    return 0
  })
  spyOn(DeviceBuild, "freePort").mockImplementation(async (port) => port)
  spyOn(DeviceBuild, "guarded").mockImplementation((_command, args) => {
    streams.push(args)
    return {
      command: process.execPath,
      args: [
        "-e",
        'console.log("http://localhost:3200"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))',
      ],
    }
  })
  spyOn(DeviceBuild, "exec").mockImplementation((command, args, options, onLine) => {
    calls.push({ command, args, cwd: options.cwd })
    onLine?.("Build output")
    return { child: new ChildProcess(), exit: Promise.resolve(0) }
  })
  spyOn(DeviceBuild, "iosTarget").mockImplementation(async (directory) => ({
    container: ["-workspace", "App.xcworkspace"],
    scheme: "App",
    bundleID: "com.test.app",
    app: path.join(directory, "App.app"),
  }))
  spyOn(DeviceBuild, "androidAbi").mockResolvedValue("arm64-v8a")
  spyOn(DeviceBuild, "androidApk").mockImplementation((directory) => path.join(directory, "app-debug.apk"))
  spyOn(DeviceBuild, "androidApp").mockResolvedValue({ id: "com.test.app", activity: ".MainActivity" })
  spyOn(DeviceBuild, "metroRunning").mockResolvedValue(true)
})

afterEach(() => mock.restore())

function preview(task: (service: DevicePreview.Interface) => Promise<void>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* DevicePreview.Service
      yield* Effect.promise(() => task(service))
    }).pipe(Effect.provide(AppNodeBuilder.build(DevicePreview.node))),
  )
}

async function project(root: string, framework: "native" | "expo" | "react-native" = "native") {
  await Bun.write(path.join(root, "android/settings.gradle"), "include ':app'")
  await Bun.write(path.join(root, "android/gradlew"), "")
  await Bun.write(path.join(root, "ios/App.xcworkspace/contents.xcworkspacedata"), "")
  if (framework === "native") return
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: framework === "expo" ? { expo: "52" } : { "react-native": "0.76" } }),
  )
  spyOn(DeviceBuild, "portOwner").mockResolvedValue({ cwd: root, pid: 0 })
}

async function until(
  service: DevicePreview.Interface,
  directory: string,
  platform: DevicePreview.Platform,
  status: DevicePreview.Build["status"],
) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const info = await Effect.runPromise(service.info({ directory }))
    if (info.builds.find((build) => build.platform === platform)?.status === status) return info
    await Bun.sleep(10)
  }
  throw new Error(
    `Timed out waiting for ${platform} ${status}: ${JSON.stringify(await Effect.runPromise(service.info({ directory })))}`,
  )
}

describe("DevicePreview lifecycle", () => {
  test.each(["native", "expo", "react-native"] as const)(
    "%s Android run builds the current directory and streams an already-booted emulator",
    async (framework) => {
      await using tmp = await tmpdir()
      await project(tmp.path, framework)
      await preview(async (service) => {
        await Effect.runPromise(service.runApp({ directory: tmp.path, platform: "android" }))
        const info = await until(service, tmp.path, "android", "running")
        expect(info.builds).toHaveLength(1)
        expect(info.servers).toHaveLength(1)
        expect(streams).toEqual([["--yes", "serve-avd", "--port", "3250", "emulator-5554"]])
        expect(calls.find((call) => call.args.includes(":app:assembleDebug"))?.cwd).toBe(path.join(tmp.path, "android"))
        expect(calls.some((call) => call.args.includes("install") && call.args[1] === "emulator-5554")).toBe(true)
        expect(
          calls.some((call) => call.args.includes("start") && call.args.includes("com.test.app/.MainActivity")),
        ).toBe(true)
        expect(calls.some((call) => call.command === "xcodebuild")).toBe(false)
        const stopped = await Effect.runPromise(service.stopApp({ directory: tmp.path, platform: "android" }))
        expect(stopped.servers).toEqual([])
        expect(stopped.builds[0].status).toBe("idle")
        expect(stopped.builds[0].device).toBeUndefined()
        expect(stopped.builds[0].log).toContain("Build output")
        expect(calls.some((call) => call.args.includes("force-stop"))).toBe(true)
        expect(shutdowns).toEqual(["android:emulator-5554"])
      })
    },
  )

  test.skipIf(process.platform !== "darwin")(
    "native iOS run boots, streams, builds, installs and launches only its simulator",
    async () => {
      await using tmp = await tmpdir()
      await project(tmp.path)
      spyOn(DeviceBuild, "deviceTarget").mockResolvedValue({
        id: "SIM-1",
        boot: { command: "xcrun", args: ["simctl", "boot", "SIM-1"] },
      })
      await preview(async (service) => {
        await Effect.runPromise(service.start({ directory: tmp.path, platform: "ios" }))
        await until(service, tmp.path, "ios", "running")
        expect(streams).toEqual([["--yes", "serve-sim", "--port", "3200", "SIM-1"]])
        expect(calls[0].args).toEqual(["simctl", "boot", "SIM-1"])
        expect(calls.find((call) => call.command === "xcodebuild")?.cwd).toBe(path.join(tmp.path, "ios"))
        expect(calls.some((call) => call.args.includes("platform=iOS Simulator,id=SIM-1"))).toBe(true)
        expect(calls.some((call) => call.args[1] === "install" && call.args[2] === "SIM-1")).toBe(true)
        expect(calls.some((call) => call.args[1] === "launch" && call.args[2] === "SIM-1")).toBe(true)
        await Effect.runPromise(service.stop({ directory: tmp.path, platform: "ios" }))
        expect(shutdowns).toEqual(["ios:SIM-1"])
      })
    },
  )

  test.skipIf(process.platform !== "darwin")(
    "focus does not launch devices and platform handoff preserves the other platform",
    async () => {
      await using tmp = await tmpdir()
      const first = path.join(tmp.path, "first")
      const second = path.join(tmp.path, "second")
      await project(first)
      await project(second)
      await preview(async (service) => {
        await Effect.runPromise(service.focus({ directory: first }))
        expect(calls).toEqual([])
        expect(streams).toEqual([])
        await Effect.runPromise(service.runApp({ directory: first, platform: "android" }))
        await until(service, first, "android", "running")
        await Effect.runPromise(service.runApp({ directory: first, platform: "ios" }))
        await until(service, first, "ios", "running")
        await Effect.runPromise(service.focus({ directory: second }))
        expect(shutdowns).toEqual([])
        await Effect.runPromise(service.runApp({ directory: second, platform: "ios" }))
        await until(service, second, "ios", "running")
        expect(shutdowns).toEqual(["ios:SIM-1"])
        expect(
          (await Effect.runPromise(service.info({ directory: first }))).servers.map((server) => server.platform),
        ).toEqual(["android"])
        await Effect.runPromise(service.stopApp({ directory: first, platform: "ios" }))
        expect((await Effect.runPromise(service.info({ directory: second }))).servers).toHaveLength(1)
        expect(
          (await Effect.runPromise(service.info({ directory: first }))).builds.find(
            (build) => build.platform === "android",
          )?.status,
        ).toBe("running")
      })
    },
  )

  test("stop during device discovery prevents a late stream or build", async () => {
    await using tmp = await tmpdir()
    await project(tmp.path)
    const target = Promise.withResolvers<Awaited<ReturnType<typeof DeviceBuild.deviceTarget>>>()
    const lookup = spyOn(DeviceBuild, "deviceTarget").mockReturnValue(target.promise)
    await preview(async (service) => {
      await Effect.runPromise(service.runApp({ directory: tmp.path, platform: "android" }))
      while (lookup.mock.calls.length === 0) await Bun.sleep(10)
      const stopping = Effect.runPromise(service.stopApp({ directory: tmp.path, platform: "android" }))
      target.resolve({ id: "emulator-5554", boot: undefined })
      await stopping
      expect(streams).toEqual([])
      expect(calls).toEqual([])
      expect(shutdowns).toEqual([])
      expect((await Effect.runPromise(service.info({ directory: tmp.path }))).builds[0].status).toBe("idle")
    })
  })

  test("failed builds retain device ownership and logs until Stop", async () => {
    await using tmp = await tmpdir()
    await project(tmp.path)
    spyOn(DeviceBuild, "androidApk").mockReturnValue(undefined)
    await preview(async (service) => {
      await Effect.runPromise(service.runApp({ directory: tmp.path, platform: "android" }))
      const failed = await until(service, tmp.path, "android", "failed")
      expect(failed.builds[0].device).toBe("emulator-5554")
      expect(failed.builds[0].error).toContain("no debug APK")
      await Effect.runPromise(service.stopApp({ directory: tmp.path, platform: "android" }))
      expect(shutdowns).toEqual(["android:emulator-5554"])
      expect((await Effect.runPromise(service.info({ directory: tmp.path }))).builds[0].log).toContain("Build output")
    })
  })

  test("stop while a preview port is being selected cannot spawn a late stream", async () => {
    await using tmp = await tmpdir()
    await project(tmp.path)
    const port = Promise.withResolvers<number | undefined>()
    const lookup = spyOn(DeviceBuild, "freePort").mockReturnValue(port.promise)
    await preview(async (service) => {
      await Effect.runPromise(service.runApp({ directory: tmp.path, platform: "android" }))
      while (lookup.mock.calls.length === 0) await Bun.sleep(10)
      const stopping = Effect.runPromise(service.stopApp({ directory: tmp.path, platform: "android" }))
      port.resolve(3250)
      await stopping
      expect(streams).toEqual([])
      expect(calls).toEqual([])
      expect(shutdowns).toEqual(["android:emulator-5554"])
    })
  })

  test("a fresh Expo project prebuilds only the requested platform before the native build", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ dependencies: { expo: "52" } }))
    spyOn(DeviceBuild, "portOwner").mockResolvedValue({ cwd: tmp.path, pid: 0 })
    spyOn(DeviceBuild, "exec").mockImplementation((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      return {
        child: new ChildProcess(),
        exit: (async () => {
          if (args.includes("prebuild")) {
            await Bun.write(path.join(tmp.path, "android/settings.gradle"), "include ':app'")
            await Bun.write(path.join(tmp.path, "android/gradlew"), "")
          }
          return 0
        })(),
      }
    })
    await preview(async (service) => {
      await Effect.runPromise(service.runApp({ directory: tmp.path, platform: "android" }))
      await until(service, tmp.path, "android", "running")
      expect(calls[0]).toEqual({ command: "npx", args: ["expo", "prebuild", "--platform", "android"], cwd: tmp.path })
      expect(calls.find((call) => call.args.includes(":app:assembleDebug"))?.cwd).toBe(path.join(tmp.path, "android"))
      expect(streams).toHaveLength(1)
      expect(streams[0]).toContain("serve-avd")
    })
  })

  test("back-to-back same-platform requests pick the newest project without duplicate builds", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")
    await project(first)
    await project(second)
    await preview(async (service) => {
      await Effect.runPromise(service.runApp({ directory: first, platform: "android" }))
      await Effect.runPromise(service.runApp({ directory: second, platform: "android" }))
      await Effect.runPromise(service.runApp({ directory: second, platform: "android" }))
      await until(service, second, "android", "running")
      expect(calls.filter((call) => call.args.includes(":app:assembleDebug")).map((call) => call.cwd)).toEqual([
        path.join(second, "android"),
      ])
      expect((await Effect.runPromise(service.info({ directory: first }))).servers).toEqual([])
    })
  })

  test("Metro-only start does not boot devices, survives app Stop, and rejects another project's Metro", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")
    await project(second, "expo")
    await project(first, "expo")
    await preview(async (service) => {
      await Effect.runPromise(service.startBundler({ directory: first }))
      expect(streams).toEqual([])
      expect(calls).toEqual([])
      await Effect.runPromise(service.runApp({ directory: first, platform: "android" }))
      await until(service, first, "android", "running")
      await Effect.runPromise(service.stopApp({ directory: first, platform: "android" }))
      expect((await Effect.runPromise(service.info({ directory: first }))).bundler?.status).toBe("running")
      const conflict = await Effect.runPromise(service.startBundler({ directory: second }))
      expect(conflict.bundler?.status).toBe("exited")
      expect(conflict.bundler?.log.join("\n")).toContain(first)
      expect((await Effect.runPromise(service.info({ directory: first }))).bundler?.status).toBe("running")
    })
  })
})
