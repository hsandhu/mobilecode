import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DevicePreview } from "@opencode-ai/core/device-preview"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { DeviceRunTool } from "@opencode-ai/core/tool/device-run"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_device_run_tool_test")
const directory = "/project"
const assertions: PermissionV2.AssertInput[] = []
const calls: string[] = []
let deny = false
let info: DevicePreview.Info = { platforms: [], servers: [], builds: [] }
// What `info` reports after a run has been started, in order.
let queue: DevicePreview.Info[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

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
    runApp: (input) => Effect.sync(() => (calls.push(`run ${input.platform}`), advance())),
    stopApp: (input) => Effect.sync(() => (calls.push(`stop ${input.platform}`), advance())),
    focus: () => Effect.die("unused"),
  }),
)

const active = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, DeviceRunTool.node]), [
    [Location.node, active],
    [PermissionV2.node, permission],
    [DevicePreview.node, preview],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
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
      const registry = yield* ToolRegistry.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([DeviceRunTool.name])
      const settled = yield* settleTool(registry, call({ action: "status" }))

      expect(settled.result).toEqual({
        type: "text",
        value: "Framework: expo\niOS: running — com.acme.app, target App",
      })
      expect(settled.output?.structured).toEqual({
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
      const registry = yield* ToolRegistry.Service

      const result = yield* executeTool(registry, call({ action: "run", timeout: 10_000 }))

      expect(calls).toEqual(["run ios", "run android"])
      expect(result).toEqual({
        type: "text",
        value: [
          "Framework: react-native",
          "iOS: running — com.acme.app",
          "Android: failed",
          "  Could not resolve com.example:missing:1.0",
          "  | > Task :app:compileDebugKotlin",
          "  | FAILURE: Build failed with an exception.",
          "Metro: running at http://localhost:8081",
        ].join("\n"),
      })
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
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, call({ action: "run", platform: "android", timeout: 1 }))

      expect(calls).toEqual(["run android"])
      expect(settled.output?.structured).toMatchObject({ complete: false, builds: [{ status: "building" }] })
      expect(settled.result.type).toBe("text")
      expect(String(settled.result.value)).toContain("Timed out waiting")
    }),
  )

  it.effect("stops only the requested platform", () =>
    Effect.gen(function* () {
      const detected = { platforms: ["ios", "android"] as const, servers: [] }
      reset(
        { ...detected, builds: [build("ios", "running"), build("android", "running")] },
        { ...detected, builds: [build("ios", "idle"), build("android", "running")] },
      )
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, call({ action: "stop", platform: "ios" }))

      expect(calls).toEqual(["stop ios"])
      expect(settled.output?.structured).toMatchObject({ builds: [{ platform: "ios", status: "idle" }] })
    }),
  )

  it.effect("fails clearly when the platform is not part of the project", () =>
    Effect.gen(function* () {
      reset({ platforms: ["android"], servers: [], builds: [] })
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ action: "run", platform: "ios" }))).toEqual({
        type: "error",
        value: "No iOS project was found. Detected: Android.",
      })
      expect(calls).toEqual([])
    }),
  )

  it.effect("fails when nothing mobile is detected", () =>
    Effect.gen(function* () {
      reset({ platforms: [], servers: [], builds: [] })
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ action: "run" }))).toEqual({
        type: "error",
        value: "No iOS or Android project was found at or below this directory.",
      })
    }),
  )

  it.effect("does nothing when permission is denied", () =>
    Effect.gen(function* () {
      reset({ platforms: ["ios"], servers: [], builds: [] })
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ action: "run" }))).toEqual({
        type: "error",
        value: "Running the app was not permitted.",
      })
      expect(calls).toEqual([])
    }),
  )
})
