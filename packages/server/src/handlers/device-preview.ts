import { DevicePreview } from "@opencode/core/device-preview"
import { Location } from "@opencode/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

export const DevicePreviewHandler = HttpApiBuilder.group(Api, "server.devicePreview", (handlers) =>
  Effect.gen(function* () {
    const preview = yield* DevicePreview.Service
    const located = <A>(run: (directory: string) => Effect.Effect<A>) =>
      response(
        Effect.gen(function* () {
          const location = yield* Location.Service
          return yield* run(location.directory)
        }),
      )

    return handlers
      .handle("devicePreview.get", () => located((directory) => preview.info({ directory })))
      .handle("devicePreview.start", (ctx) =>
        located((directory) => preview.start({ directory, platform: ctx.payload.platform })),
      )
      .handle("devicePreview.stop", (ctx) =>
        located((directory) => preview.stop({ directory, platform: ctx.payload.platform })),
      )
      .handle("devicePreview.startBundler", () => located((directory) => preview.startBundler({ directory })))
      .handle("devicePreview.stopBundler", () => located((directory) => preview.stopBundler({ directory })))
      .handle("devicePreview.runApp", (ctx) =>
        located((directory) =>
          preview.runApp({ directory, platform: ctx.payload.platform, relaunch: ctx.payload.relaunch }),
        ),
      )
      .handle("devicePreview.focus", () => located((directory) => preview.focus({ directory })))
      .handle("devicePreview.stopApp", (ctx) =>
        located((directory) => preview.stopApp({ directory, platform: ctx.payload.platform })),
      )
  }),
)
