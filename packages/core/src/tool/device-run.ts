export * as DeviceRunTool from "./device-run"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { DevicePreview } from "../device-preview"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "device_run"

const POLL_MS = 2000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_TIMEOUT_MS = 30 * 60_000
const LOG_TAIL = 60
const BUSY: DevicePreview.Build["status"][] = ["building", "installing", "launching"]

// Declared here rather than imported so the tool's codecs carry no cross-package service types.
const Platform = Schema.Literals(["ios", "android"])
const Framework = Schema.Literals(["expo", "react-native", "native"])
const BuildStatus = Schema.Literals(["idle", "building", "installing", "launching", "running", "failed"])
const ServerStatus = Schema.Literals(["starting", "running", "exited"])

export const Input = Schema.Struct({
  action: Schema.Literals(["run", "stop", "status"]).annotate({
    description:
      "run: build, install and launch the app, then wait for the result. stop: terminate the running app or cancel its build. status: report the current state without changing anything.",
  }),
  platform: Schema.optional(Schema.Literals(["ios", "android", "all"])).annotate({
    description: "Which device to target. Defaults to all detected platforms.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: `How long to wait for a run to finish, in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}).`,
  }),
})
export type Input = typeof Input.Type

export const BuildSummary = Schema.Struct({
  platform: Platform,
  status: BuildStatus,
  step: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  appID: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  log: Schema.Array(Schema.String),
})
export type BuildSummary = typeof BuildSummary.Type

export const Output = Schema.Struct({
  framework: Schema.optional(Framework),
  platforms: Schema.Array(Platform),
  builds: Schema.Array(BuildSummary),
  bundler: Schema.optional(
    Schema.Struct({
      status: ServerStatus,
      url: Schema.optional(Schema.String),
      log: Schema.Array(Schema.String),
    }),
  ),
  /** False when the wait ran out before every build settled. */
  complete: Schema.Boolean,
})
export type Output = typeof Output.Type

const label = (platform: DevicePreview.Platform) => (platform === "ios" ? "iOS" : "Android")

export function summarize(info: DevicePreview.Info, targets: ReadonlyArray<DevicePreview.Platform>, complete = true) {
  const builds = targets.flatMap((platform) => {
    const build = info.builds.find((item) => item.platform === platform)
    if (!build) return []
    const failed = build.status === "failed"
    return [
      {
        platform,
        status: build.status,
        ...(build.step === undefined ? {} : { step: build.step }),
        ...(build.target === undefined ? {} : { target: build.target }),
        ...(build.appID === undefined ? {} : { appID: build.appID }),
        ...(build.error === undefined ? {} : { error: build.error }),
        // The log only earns its tokens when something went wrong or is still going.
        log: failed || !complete ? build.log.slice(-LOG_TAIL) : [],
      },
    ]
  })
  const bundler = info.bundler
  return {
    ...(info.framework === undefined ? {} : { framework: info.framework }),
    platforms: info.platforms,
    builds,
    ...(bundler
      ? {
          bundler: {
            status: bundler.status,
            ...(bundler.url === undefined ? {} : { url: bundler.url }),
            log: bundler.status === "exited" || !complete ? bundler.log.slice(-LOG_TAIL) : [],
          },
        }
      : {}),
    complete,
  } satisfies Output
}

export function toModelOutput(output: Output) {
  const lines: string[] = []
  if (output.framework) lines.push(`Framework: ${output.framework}`)
  if (output.builds.length === 0) lines.push("No app has been run yet.")
  for (const build of output.builds) {
    const detail = [build.appID, build.target && `target ${build.target}`].filter(Boolean).join(", ")
    const head = `${label(build.platform)}: ${build.status}${build.step ? ` (${build.step})` : ""}${detail ? ` — ${detail}` : ""}`
    lines.push(build.error ? `${head}\n  ${build.error}` : head)
    if (build.log.length > 0) lines.push(indent(build.log))
  }
  if (output.bundler) {
    lines.push(`Metro: ${output.bundler.status}${output.bundler.url ? ` at ${output.bundler.url}` : ""}`)
    if (output.bundler.log.length > 0) lines.push(indent(output.bundler.log))
  }
  if (!output.complete)
    lines.push(
      'Timed out waiting for the run to finish; it is still in progress. Call again with action "status" to check on it.',
    )
  return lines.join("\n")
}

function indent(log: ReadonlyArray<string>) {
  return log.map((line) => `  | ${line}`).join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const preview = yield* DevicePreview.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Build, install and launch the mobile app in this project on the iOS Simulator and Android Emulator, the same way the Play button in the device pane does, and wait for the result. Works for Expo (prebuild runs automatically), React Native (Metro is started for you) and plain native projects. Use it after creating or changing a mobile app to check that it builds and launches; when a build fails, the reported error and log tail say why, so fix that and run again. The user sees the app running in the device pane.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const wanted = input.platform ?? "all"
              yield* permission.assert({
                action: name,
                resources: [wanted],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const directory = location.directory
              const info = yield* preview.info({ directory })
              const targets = wanted === "all" ? info.platforms : [wanted]
              if (info.platforms.length === 0)
                return yield* new ToolFailure({
                  message: "No iOS or Android project was found at or below this directory.",
                })
              const missing = targets.filter((platform) => !info.platforms.includes(platform))
              if (missing.length > 0)
                return yield* new ToolFailure({
                  message: `No ${label(missing[0]!)} project was found. Detected: ${info.platforms.map(label).join(", ")}.`,
                })

              if (input.action === "status") return summarize(info, targets)

              if (input.action === "stop") {
                let latest = info
                for (const platform of targets) latest = yield* preview.stopApp({ directory, platform })
                return summarize(latest, targets)
              }

              let latest = info
              for (const platform of targets) latest = yield* preview.runApp({ directory, platform })
              const timeout = Math.min(Math.max(input.timeout ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS)
              const deadline = (yield* Clock.currentTimeMillis) + timeout
              const busy = (current: DevicePreview.Info) =>
                targets.some((platform) => {
                  const build = current.builds.find((item) => item.platform === platform)
                  return !!build && BUSY.includes(build.status)
                })
              while (busy(latest)) {
                if ((yield* Clock.currentTimeMillis) >= deadline) return summarize(latest, targets, false)
                yield* Effect.sleep(POLL_MS)
                latest = yield* preview.info({ directory })
              }
              return summarize(latest, targets)
            }).pipe(
              Effect.mapError((error) => {
                if (error._tag === "LLM.ToolFailure") return error
                if (error._tag === "PermissionV2.BlockedError")
                  return new ToolFailure({ message: "Running the app was not permitted." })
                return new ToolFailure({ message: `Unable to run the app: ${error.message}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/device-run",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node, DevicePreview.node],
})
