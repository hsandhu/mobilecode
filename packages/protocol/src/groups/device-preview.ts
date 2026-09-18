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
            "Start the virtual device and its preview stream, then build, install and launch the requested location's app for one platform. Equivalent to runApp; poll the get endpoint for progress.",
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
          description:
            "Cancel the location's build, terminate its app, stop its preview stream and shut down its virtual device for one platform. Equivalent to stopApp.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.startBundler", "/api/device-preview/bundler/start", {
      query: LocationQuery,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.startBundler",
          summary: "Start Metro",
          description: "Start the Metro bundler for the React Native or Expo project at the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.stopBundler", "/api/device-preview/bundler/stop", {
      query: LocationQuery,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.stopBundler",
          summary: "Stop Metro",
          description: "Stop the Metro bundler for the React Native or Expo project at the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.runApp", "/api/device-preview/run", {
      query: LocationQuery,
      payload: DevicePreview.RunInput,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.runApp",
          summary: "Build and run the app",
          description:
            "Start and stream one virtual device, build the location's native project, install it and launch it on that same device. Expo apps are prebuilt first, and React Native apps get Metro started when needed. Only an existing run on the same platform is replaced; the other platform is untouched. Returns immediately; poll the get endpoint for progress.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("devicePreview.focus", "/api/device-preview/focus", {
      query: LocationQuery,
      success: Location.response(DevicePreview.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.devicePreview.focus",
          summary: "Read the focused location's device status",
          description:
            "Compatibility endpoint that returns device status without starting, stopping or transferring devices. Switching locations never starts a build.",
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
          description:
            "Cancel the location's in-flight build, terminate its app, stop its preview stream and shut down its virtual device for the selected platform. Other locations and platforms are untouched. Manually started Metro remains running.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "device-preview",
      description: "Simulator and emulator preview servers for mobile projects.",
    }),
  )
