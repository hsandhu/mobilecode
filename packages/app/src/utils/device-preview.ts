import { DevicePreview } from "@opencode-ai/schema/device-preview"
import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const decode = Schema.decodeUnknownSync(Schema.Struct({ data: DevicePreview.Info }))

export type DevicePreviewApi = ReturnType<typeof createDevicePreviewApi>

// The vendored v2 client predates this endpoint, so the app talks to it directly.
export function createDevicePreviewApi(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  const request = async (path: string, directory: string, init?: RequestInit) => {
    const url = new URL(`${input.server.url}${path}`)
    url.searchParams.set("location[directory]", directory)
    const response = await (input.fetch ?? globalThis.fetch)(url, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(input.server.password
          ? {
              authorization: `Basic ${authTokenFromCredentials({
                username: input.server.username,
                password: input.server.password,
              })}`,
            }
          : {}),
      },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
    return decode(await response.json()).data
  }

  return {
    get: (directory: string) => request("/api/device-preview", directory),
    start: (directory: string, platform: DevicePreview.Platform) =>
      request("/api/device-preview/start", directory, { method: "POST", body: JSON.stringify({ platform }) }),
    stop: (directory: string, platform: DevicePreview.Platform) =>
      request("/api/device-preview/stop", directory, { method: "POST", body: JSON.stringify({ platform }) }),
    runApp: (directory: string, platform: DevicePreview.Platform) =>
      request("/api/device-preview/run", directory, { method: "POST", body: JSON.stringify({ platform }) }),
    stopApp: (directory: string, platform: DevicePreview.Platform) =>
      request("/api/device-preview/run/stop", directory, { method: "POST", body: JSON.stringify({ platform }) }),
  }
}

// serve-sim/serve-avd bind to loopback on the machine running the opencode server. When that server
// is remote, point the preview at the server's host instead of the viewer's own loopback.
export function devicePreviewUrl(url: string | undefined, server: string) {
  if (!url || !URL.canParse(url) || !URL.canParse(server)) return url
  const target = new URL(url)
  const origin = new URL(server)
  if (LOOPBACK.has(origin.hostname) || !LOOPBACK.has(target.hostname)) return target.href
  target.hostname = origin.hostname
  return target.href
}
