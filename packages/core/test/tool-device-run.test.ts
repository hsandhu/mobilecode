import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DevicePreview } from "@opencode/core/device-preview"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { DeviceRunTool } from "@opencode/core/tool/plugin/device-run"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_device_run_tool_test")
const directory = "/project"
const assertions: Permission.AssertInput[] = []
const calls: string[] = []
let deny = false
let info: DevicePreview.Info = { platforms: [], servers: [], builds: [] }
// What `info` reports after a run has been started, in order.
let queue: DevicePreview.Info[] = []

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        deny
          ? Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }))
          : Effect.void,
      ),
    ),
})

const advance = () => {
  const next = queue.shift()
  if (next) info = next
  return info
}

const preview = Layer.succeed(
  DevicePreview.Service,
  DevicePreview.Service.of({
    detect: () => Effect.succeed([...info.platforms]),
    info: () => Effect.sync(advance),
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    startBundler: () => Effect.die("unused"),
    stopBundler: () => Effect.die("unused"),
    runApp: (input) => Effect.sync(() => (calls.push(`run ${input.platform}`), advance())),
    stopApp: (input) => Effect.sync(() => (calls.push(`stop ${input.platform}`), advance())),
    focus: () => Effect.die("unused"),
  }),
)

const active = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
)

const deviceRunNode = makeLocationNode({
  name: "test/device-run-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(DeviceRunTool.Plugin)),
  deps: [Tool.node, Permission.node, Location.node, DevicePreview.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, deviceRunNode]), [
    Location.node.replace(active),
    Permission.node.replace(permission),
    DevicePreview.node.replace(preview),
  ]),
)

const build = (
  platform: DevicePreview.Platform,
  status: DevicePreview.Build["status"],
  extra: Partial<DevicePreview.Build> = {},
): DevicePreview.Build => ({ platform, status, log: [], ...extra })

const reset = (next: DevicePreview.Info, ...after: DevicePreview.Info[]) => {
  assertions.length = 0
  calls.length = 0
  deny = false
  info = next
  queue = after
}

const call = (input: DeviceRunTool.Input, id = "call-device-run") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: DeviceRunTool.name, input },
})

describe("DeviceRunTool", () => {
  it.effect("registers and reports status without touching the device", () =>
    Effect.gen(function* () {
      reset({
        platforms: ["ios", "android"],
        framework: "expo",
        servers: [],
        builds: [build("ios", "running", { appID: "com.acme.app", target: "App" })],
      })
      const registry = yield* Tool.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain(DeviceRunTool.name)
      const settled = yield* executeTool(registry, call({ action: "status" }))

      expect(settled.content).toEqual([{ type: "text", text: "Framework: expo\niOS: running — com.acme.app, target App" }])
      expect(settled.output).toEqual({
        framework: "expo",
        platforms: ["ios", "android"],
        builds: [{ platform: "ios", status: "running", target: "App", appID: "com.acme.app", log: [] }],
        complete: true,
      })
      expect(calls).toEqual([])
      expect(assertions).toMatchObject([{ sessionID, action: "device_run", resources: ["all"] }])
    }),
  )

  it.effect("runs every detected platform and waits for the builds to settle", () =>
    Effect.gen(function* () {
      const detected = { platforms: ["ios", "android"] as const, framework: "react-native" as const, servers: [] }
      reset(
        { ...detected, builds: [] },
        { ...detected, builds: [build("ios", "building", { step: "Building App" })] },
        { ...detected, builds: [build("ios", "building"), build("android", "building")] },
        {
          ...detected,
          builds: [
            build("ios", "running", { appID: "com.acme.app" }),
            build("android", "failed", {
              error: "Could not resolve com.example:missing:1.0",
              log: ["> Task :app:compileDebugKotlin", "FAILURE: Build failed with an exception."],
            }),
          ],
          bundler: {
            framework: "react-native",
            directory,
            status: "running",
            command: "npx react-native start",
            url: "http://localhost:8081",
            log: ["Dev server ready"],
          },
        },
      )
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, call({ action: "run", timeout: 10_000 }))

      expect(calls).toEqual(["run ios", "run android"])
      expect(result.content).toEqual([
        {
          type: "text",
          text: [
          "Framework: react-native",
          "iOS: running — com.acme.app",
          "Android: failed",
          "  Could not resolve com.example:missing:1.0",
          "  | > Task :app:compileDebugKotlin",
          "  | FAILURE: Build failed with an exception.",
            "Metro: running at http://localhost:8081",
          ].join("\n"),
        },
      ])
    }),
  )

  // Live clock: the poll sleeps for real, and the virtual test clock never advances on its own.
  it.live("gives up waiting at the timeout but reports what is still going", () =>
    Effect.gen(function* () {
      const detected = { platforms: ["android"] as const, servers: [] }
      reset(
        { ...detected, builds: [] },
        { ...detected, builds: [build("android", "building", { step: "Building app" })] },
      )
      const registry = yield* Tool.Service

      const settled = yield* executeTool(registry, call({ action: "run", platform: "android", timeout: 1 }))

      expect(calls).toEqual(["run android"])
      expect(settled.output).toMatchObject({ complete: false, builds: [{ status: "building" }] })
      expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining("Timed out waiting") }])
    }),
  )

  it.effect("stops only the requested platform", () =>
    Effect.gen(function* () {
      const detected = { platforms: ["ios", "android"] as const, servers: [] }
      reset(
        { ...detected, builds: [build("ios", "running"), build("android", "running")] },
        { ...detected, builds: [build("ios", "idle"), build("android", "running")] },
      )
      const registry = yield* Tool.Service

      const settled = yield* executeTool(registry, call({ action: "stop", platform: "ios" }))

      expect(calls).toEqual(["stop ios"])
      expect(settled.output).toMatchObject({ builds: [{ platform: "ios", status: "idle" }] })
    }),
  )

  it.effect("fails clearly when the platform is not part of the project", () =>
    Effect.gen(function* () {
      reset({ platforms: ["android"], servers: [], builds: [] })
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ action: "run", platform: "ios" }))).toMatchObject({
        status: "error",
        error: { message: "No iOS project was found. Detected: Android." },
      })
      expect(calls).toEqual([])
    }),
  )

  it.effect("fails when nothing mobile is detected", () =>
    Effect.gen(function* () {
      reset({ platforms: [], servers: [], builds: [] })
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ action: "run" }))).toMatchObject({
        status: "error",
        error: { message: "No iOS or Android project was found at or below this directory." },
      })
    }),
  )

  it.effect("does nothing when permission is denied", () =>
    Effect.gen(function* () {
      reset({ platforms: ["ios"], servers: [], builds: [] })
      deny = true
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ action: "run" }))).toMatchObject({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: device_run" },
      })
      expect(calls).toEqual([])
    }),
  )
})
