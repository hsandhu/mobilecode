import { DevicePreview } from "@opencode-ai/core/device-preview"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { PtyEnvironment } from "../pty-environment"

export const DevicePreviewHandler = HttpApiBuilder.group(Api, "server.devicePreview", (handlers) =>
  Effect.gen(function* () {
    const preview = yield* DevicePreview.Service
    const environment = yield* PtyEnvironment.Service

    return handlers
      .handle("devicePreview.get", () =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            return yield* preview.info({ directory: location.directory })
          }),
        ),
      )
      .handle("devicePreview.start", (ctx) =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            // Same host environment overlay terminals get, so `npx` resolves like it would in a PTY.
            const env = yield* environment.get({ directory: location.directory, cwd: location.directory })
            return yield* preview.start({ directory: location.directory, platform: ctx.payload.platform, env })
          }),
        ),
      )
      .handle("devicePreview.runApp", (ctx) =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            const env = yield* environment.get({ directory: location.directory, cwd: location.directory })
            return yield* preview.runApp({ directory: location.directory, platform: ctx.payload.platform, env })
          }),
        ),
      )
      .handle("devicePreview.stopApp", (ctx) =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            return yield* preview.stopApp({ directory: location.directory, platform: ctx.payload.platform })
          }),
        ),
      )
      .handle("devicePreview.stop", (ctx) =>
        response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            return yield* preview.stop({ directory: location.directory, platform: ctx.payload.platform })
          }),
        ),
      )
  }),
)
