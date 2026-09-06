import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createDevicePreviewApi } from "@/utils/device-preview"

export const DEVICE_TAB = "device"
const ACTIVE_POLL_MS = 1500
const IDLE_POLL_MS = 8000
const BUSY: DevicePreview.BuildStatus[] = ["building", "installing", "launching"]

export const deviceBuildBusy = (build: DevicePreview.Build | undefined) => !!build && BUSY.includes(build.status)

export function devicePreviewIcon(platform: DevicePreview.Platform) {
  return platform === "ios" ? ("xcode" as const) : ("android-studio" as const)
}

/** Icon for a control that spans every platform: the React logo for JS apps, else nothing specific. */
export function deviceFrameworkIcon(framework: DevicePreview.Framework | undefined) {
  return framework === "expo" || framework === "react-native" ? ("react" as const) : undefined
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type Shared = ReturnType<typeof createShared>["shared"]

// One poller per server and directory, shared by the header control, the device tab and the
// side panel so they never disagree and never poll the same endpoint several times over.
const cache = new Map<string, { shared: Shared; dispose: () => void; refs: number }>()

function createShared(server: ServerConnection.HttpBase, directory: string, fetch?: typeof globalThis.fetch) {
  return createRoot((disposeRoot) => {
    const api = createDevicePreviewApi({ server, fetch })
    const [store, setStore] = createStore<{ info?: DevicePreview.Info; error?: string }>({})
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    // Every request takes a ticket; only the newest response may land, so a slow background poll
    // cannot overwrite the "building" state a play click just returned.
    let ticket = 0
    const apply = (id: number, next: { info?: DevicePreview.Info; error?: string }) => {
      if (id !== ticket) return
      if (next.info) setStore({ info: next.info, error: undefined })
      else setStore("error", next.error)
    }

    const active = () => {
      const info = store.info
      if (!info) return false
      return info.servers.some((item) => item.status !== "exited") || info.builds.some(deviceBuildBusy)
    }
    const refresh = async () => {
      const id = ++ticket
      try {
        apply(id, { info: await api.get(directory) })
      } catch (error) {
        apply(id, { error: message(error) })
      }
    }
    // One timer only: two overlapping actions (play on both devices) used to leave two loops running.
    const schedule = () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(loop, active() ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }
    const loop = async () => {
      if (stopped) return
      await refresh()
      schedule()
    }
    const act = async (task: Promise<DevicePreview.Info>) => {
      if (timer) clearTimeout(timer)
      const id = ++ticket
      try {
        apply(id, { info: await task })
      } catch (error) {
        apply(id, { error: message(error) })
      }
      schedule()
    }

    void loop()

    return {
      shared: {
        store,
        refresh,
        start: (platform: DevicePreview.Platform) => act(api.start(directory, platform)),
        stop: (platform: DevicePreview.Platform) => act(api.stop(directory, platform)),
        runApp: (platform: DevicePreview.Platform) => act(api.runApp(directory, platform)),
        stopApp: (platform: DevicePreview.Platform) => act(api.stopApp(directory, platform)),
        focus: () => act(api.focus(directory)),
      },
      dispose: () => {
        stopped = true
        if (timer) clearTimeout(timer)
        disposeRoot()
      },
    }
  })
}

/** Device detection, preview servers and build state for the current session directory. */
export function createDeviceState() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const key = createMemo(() => `${serverSDK().url}\n${sdk().directory}`)

  const shared = createMemo(() => {
    const id = key()
    const existing = cache.get(id)
    if (existing) {
      existing.refs += 1
      onCleanup(() => release(id))
      return existing.shared
    }
    const created = createShared(serverSDK().server.http, sdk().directory, platform.fetch)
    cache.set(id, { ...created, refs: 1 })
    onCleanup(() => release(id))
    return created.shared
  })

  const info = createMemo(() => shared().store.info)
  return {
    info,
    error: createMemo(() => shared().store.error),
    platforms: createMemo(() => info()?.platforms ?? []),
    server: (value: DevicePreview.Platform) => info()?.servers.find((item) => item.platform === value),
    build: (value: DevicePreview.Platform) => info()?.builds.find((item) => item.platform === value),
    refresh: () => shared().refresh(),
    start: (value: DevicePreview.Platform) => shared().start(value),
    stop: (value: DevicePreview.Platform) => shared().stop(value),
    runApp: (value: DevicePreview.Platform) => shared().runApp(value),
    stopApp: (value: DevicePreview.Platform) => shared().stopApp(value),
    focus: () => shared().focus(),
  }
}

function release(id: string) {
  const entry = cache.get(id)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  entry.dispose()
  cache.delete(id)
}

const autoOpened = new Set<string>()
const seenBuilds = new Set<string>()
let focused: string | undefined

/**
 * Open the device pane by itself the first time a session is shown for a mobile project, and
 * again whenever a new build starts, which is how an agent-triggered run becomes visible.
 * Each trigger fires once, so closing the tab keeps it closed until the next build.
 */
export function createDeviceAutoOpen() {
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const device = createDeviceState()

  const open = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    void tabs().open(DEVICE_TAB)
    tabs().setActive(DEVICE_TAB)
  }

  createEffect(() => {
    if (!params.id || !isDesktop()) return
    if (device.platforms().length === 0) return
    const key = sessionKey()
    if (autoOpened.has(key)) return
    autoOpened.add(key)
    open()
  })

  // Switching tabs between two mobile projects hands the devices to the one now in front. The
  // server decides whether anything actually changes: it only acts when another project was
  // running, or this one was parked by an earlier switch.
  createEffect(() => {
    if (!params.id || !isDesktop()) return
    if (device.platforms().length === 0) return
    const key = sessionKey()
    if (focused === key) return
    focused = key
    void device.focus()
  })

  createEffect(() => {
    if (!params.id || !isDesktop()) return
    const key = sessionKey()
    let fresh = false
    for (const platform of device.platforms()) {
      const build = device.build(platform)
      if (!build || !deviceBuildBusy(build) || build.startedAt === undefined) continue
      const id = `${key}\n${platform}\n${build.startedAt}`
      if (seenBuilds.has(id)) continue
      seenBuilds.add(id)
      fresh = true
    }
    if (fresh) open()
  })
}
