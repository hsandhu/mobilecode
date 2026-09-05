import { DevicePreview } from "@opencode-ai/schema/device-preview"
import { Location } from "@opencode-ai/schema/location"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const DevicePreviewGroup = HttpApiGroup.make("server.devicePreview")
  .add(
    HttpApiEndpoint.get("devicePreview.get", "/api/device-preview", {
      query: LocationQuery,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.get",
          summary: "Get device preview",
          description:
            "Detect iOS and Android projects at the requested location and report running simulator or emulator preview servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.start", "/api/device-preview/start", {
      query: LocationQuery,
      payload: DevicePreview.PlatformInput,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.start",
          summary: "Start device preview",
          description:
            "Start serve-sim (iOS) or serve-avd (Android) for the requested location. Poll the get endpoint until the server reports a URL.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.stop", "/api/device-preview/stop", {
      query: LocationQuery,
      payload: DevicePreview.PlatformInput,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.stop",
          summary: "Stop device preview",
          description: "Stop the simulator or emulator preview server for one platform.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.runApp", "/api/device-preview/run", {
      query: LocationQuery,
      payload: DevicePreview.PlatformInput,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.runApp",
          summary: "Build and run the app",
          description:
            "Build the native project for one platform, install it on the running simulator or emulator, and launch it. Returns immediately; poll the get endpoint for progress.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.stopApp", "/api/device-preview/run/stop", {
      query: LocationQuery,
      payload: DevicePreview.PlatformInput,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.stopApp",
          summary: "Stop the running app",
          description: "Cancel an in-flight build, or terminate the app if it is already running on the device.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "device-preview",
      description: "Simulator and emulator preview servers for mobile projects.",
    }),
  )
