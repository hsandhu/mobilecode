import type { DevicePreview } from "@opencode/schema/device-preview"
import { comparablePath, containsDirectory, getFilename } from "@opencode/util/path"
import type { DevicePlatform } from "./machine"

/**
 * serve-sim and the emulator preview bind to loopback on the machine that runs the server. When that server is remote,
 * points the preview at the server's host instead of the viewer's own loopback.
 */
export function devicePreviewUrl(url: string | undefined, server: string) {
  if (!url || !URL.canParse(url) || !URL.canParse(server)) return url
  const target = new URL(url)
  const origin = new URL(server)

  if (loopback(origin.hostname) || !loopback(target.hostname)) return target.href
  target.hostname = origin.hostname

  return target.href
}

/**
 * The project folder Metro serves, as the user knows it: from the session directory's own folder name down, so
 * `/work/app` shows `app` and `/work/app/mobile` shows `app/mobile`. A folder outside the session shows in full.
 */
export function deviceMetroPath(bundler: string, session: string) {
  const name = getFilename(session)

  if (!name || !containsDirectory(session, bundler)) return bundler
  const rest = comparablePath(bundler).slice(comparablePath(session).length).replace(/^\/+/, "")

  return rest ? `${name}/${rest}` : name
}

/** The app icon of a platform's device. */
export function devicePlatformIcon(platform: DevicePlatform) {
  return platform === "ios" ? ("xcode" as const) : ("android-studio" as const)
}

/** The icon of a control that spans every platform: the React logo for a JavaScript app, else none. */
export function deviceFrameworkIcon(framework: DevicePreview.Info["framework"]) {
  return framework === "expo" || framework === "react-native" ? ("react" as const) : undefined
}

function loopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}
