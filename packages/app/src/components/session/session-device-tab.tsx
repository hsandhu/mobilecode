import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { devicePreviewUrl } from "@/utils/device-preview"
import { createDeviceState, deviceBuildBusy, devicePreviewIcon } from "./device-state"

const ALL_PLATFORMS: DevicePreview.Platform[] = ["ios", "android"]
const LOG_TAIL = 40
// Two phone-shaped streams need at least this much before a split beats a toggle.
const SPLIT_MIN_WIDTH = 640

type DeviceState = ReturnType<typeof createDeviceState>

/**
 * The device tab: one preview pane per detected platform, side by side when there is room for
 * both, otherwise a single pane with a platform toggle. Metro status sits above the panes since
 * one bundler serves both apps.
 */
export function SessionDeviceTab() {
  const language = useLanguage()
  const device = createDeviceState()
  let container: HTMLDivElement | undefined
  const [width, setWidth] = createSignal(0)
  createResizeObserver(
    () => container,
    ({ width }) => setWidth(width),
  )

  const [store, setStore] = createStore({
    selected: undefined as DevicePreview.Platform | undefined,
    started: {} as Partial<Record<DevicePreview.Platform, boolean>>,
    showBundlerLog: false,
  })

  const detected = createMemo(() => device.platforms())
  const options = createMemo(() => (detected().length > 0 ? detected() : ALL_PLATFORMS))
  const selected = createMemo(() => store.selected ?? options()[0])
  const split = createMemo(() => detected().length > 1 && width() >= SPLIT_MIN_WIDTH)
  const bundler = createMemo(() => device.info()?.bundler)
  const bundlerText = createMemo(() => {
    const value = bundler()
    if (!value) return ""
    if (value.status === "running") return language.t("session.device.bundler.running", { url: value.url ?? "" })
    if (value.status === "exited") return language.t("session.device.bundler.exited")
    return language.t("session.device.bundler.starting")
  })

  // Opening the pane starts a preview for every detected platform, once. Stop stays respected.
  createEffect(() => {
    if (!device.info()) return
    for (const value of detected()) {
      if (store.started[value]) continue
      setStore("started", value, true)
      if (!device.server(value)) void device.start(value)
    }
  })

  return (
    <div ref={container} class="flex flex-col h-full min-h-0">
      <Show when={bundler()}>
        {(value) => (
          <>
            <div class="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border-weaker-base text-11-regular text-text-weak">
              <Show when={value().status === "starting"}>
                <Spinner class="size-3 shrink-0" />
              </Show>
              <span class="min-w-0 flex-1 truncate" title={bundlerText()}>
                {bundlerText()}
              </span>
              <Button size="small" variant="ghost" onClick={() => setStore("showBundlerLog", !store.showBundlerLog)}>
                {store.showBundlerLog ? language.t("session.device.hideLog") : language.t("session.device.showLog")}
              </Button>
            </div>
            <Show when={store.showBundlerLog}>
              <pre class="max-h-40 shrink-0 overflow-auto px-3 py-2 whitespace-pre-wrap text-11-regular text-text-weak bg-background-stronger border-b border-border-weaker-base select-text">
                {value().log.slice(-LOG_TAIL).join("\n")}
              </pre>
            </Show>
          </>
        )}
      </Show>
      <div class="relative flex flex-1 min-h-0">
        <Show
          when={split()}
          fallback={
            <Show when={selected()}>
              {(value) => (
                <DevicePane
                  device={device}
                  platform={value()}
                  detected={detected()}
                  options={options()}
                  onSelect={(next) => setStore("selected", next)}
                  class="flex-1"
                />
              )}
            </Show>
          }
        >
          <For each={detected()}>
            {(value, index) => (
              <DevicePane
                device={device}
                platform={value}
                detected={detected()}
                class="flex-1 basis-0"
                classList={{ "border-l border-border-weaker-base": index() > 0 }}
              />
            )}
          </For>
        </Show>
        <Show when={device.error()}>
          <div class="absolute inset-x-0 bottom-0 px-3 py-2 text-11-regular text-text-weak bg-background-stronger border-t border-border-weaker-base">
            {device.error()}
          </div>
        </Show>
      </div>
    </div>
  )
}

function DevicePane(props: {
  device: DeviceState
  platform: DevicePreview.Platform
  detected: readonly DevicePreview.Platform[]
  /** When given with more than one entry, the header shows a platform toggle. */
  options?: readonly DevicePreview.Platform[]
  onSelect?: (platform: DevicePreview.Platform) => void
  class?: string
  classList?: Record<string, boolean | undefined>
}) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  let frame: HTMLIFrameElement | undefined
  const [showLog, setShowLog] = createSignal(false)

  const server = createMemo(() => props.device.server(props.platform))
  const build = createMemo(() => props.device.build(props.platform))
  const url = createMemo(() => devicePreviewUrl(server()?.url, serverSDK().url))
  const running = createMemo(() => server()?.status === "running" && !!url())
  const label = (value: DevicePreview.Platform) =>
    value === "ios" ? language.t("session.device.platform.ios") : language.t("session.device.platform.android")
  const log = createMemo(() => {
    const current = build()
    const fromBuild = current && (deviceBuildBusy(current) || current.status === "failed")
    const lines = fromBuild ? current.log : (server()?.log ?? [])
    return lines.slice(-LOG_TAIL).join("\n")
  })

  // The build's own state takes the header slot while it matters; otherwise the stream address.
  const progress = createMemo(() => {
    const current = build()
    if (current && deviceBuildBusy(current))
      return { text: current.step ?? language.t("session.device.run.building"), failed: false }
    if (current?.status === "failed") return { text: language.t("session.device.run.failed"), failed: true }
    if (current?.status === "running")
      return { text: `${language.t("session.device.run.running")} · ${current.appID ?? ""}`.trim(), failed: false }
    return { text: url() ?? server()?.command ?? "", failed: false }
  })

  const reload = () => {
    const next = url()
    if (!frame || !next) return
    frame.src = next
  }

  onCleanup(() => {
    frame = undefined
  })

  return (
    <div class={`flex flex-col h-full min-h-0 min-w-0 ${props.class ?? ""}`} classList={props.classList}>
      <div class="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border-weaker-base">
        <Show
          when={props.options && props.options.length > 1 ? props.options : undefined}
          fallback={
            <div class="flex items-center gap-1.5 text-12-medium text-text-strong">
              <AppIcon id={devicePreviewIcon(props.platform)} style={{ width: "16px", height: "16px" }} />
              <span>{label(props.platform)}</span>
            </div>
          }
        >
          {(options) => (
            <div class="flex items-center gap-1">
              <For each={options()}>
                {(value) => (
                  <Button
                    size="small"
                    variant={props.platform === value ? "secondary" : "ghost"}
                    onClick={() => props.onSelect?.(value)}
                  >
                    <AppIcon id={devicePreviewIcon(value)} style={{ width: "14px", height: "14px" }} />
                    {label(value)}
                  </Button>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="flex min-w-0 flex-1 items-center gap-1.5 text-12-regular">
          <Show when={deviceBuildBusy(build())}>
            <Spinner class="size-3 shrink-0" />
          </Show>
          <span
            class="min-w-0 truncate"
            classList={{
              "text-text-weak": !progress().failed,
              "text-text-danger-base": progress().failed,
            }}
            title={progress().text}
          >
            {progress().text}
          </span>
        </div>
        <Show when={build()?.status === "failed" || deviceBuildBusy(build())}>
          <Button size="small" variant="ghost" onClick={() => setShowLog(!showLog())}>
            {showLog() ? language.t("session.device.hideLog") : language.t("session.device.showLog")}
          </Button>
        </Show>
        <Show when={running()}>
          <Button size="small" variant="ghost" onClick={reload}>
            {language.t("session.device.reload")}
          </Button>
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            title={language.t("session.device.openExternal")}
            aria-label={language.t("session.device.openExternal")}
            onClick={() => {
              const value = url()
              if (value) platform.openExternal(value)
            }}
          />
        </Show>
        <Show
          when={server() && server()!.status !== "exited"}
          fallback={
            <Button size="small" onClick={() => void props.device.start(props.platform)}>
              {language.t("session.device.start")}
            </Button>
          }
        >
          <Button size="small" variant="ghost" onClick={() => void props.device.stop(props.platform)}>
            {language.t("session.device.stop")}
          </Button>
        </Show>
      </div>
      <div class="relative flex-1 min-h-0">
        <Switch>
          <Match when={running()}>
            <iframe
              ref={frame}
              src={url()}
              title={label(props.platform)}
              class="absolute inset-0 w-full h-full border-0 bg-background-base"
              allow="clipboard-read; clipboard-write; fullscreen; autoplay"
              referrerpolicy="no-referrer"
            />
          </Match>
          <Match when={server()?.status === "starting"}>
            <div class="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
              <Spinner class="size-4" />
              <div class="text-12-regular text-text-weak">
                {language.t("session.device.status.starting", { command: server()?.command ?? "" })}
              </div>
            </div>
          </Match>
          <Match when={server()?.status === "exited"}>
            <div class="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
              <div class="text-12-regular text-text-weak">{language.t("session.device.status.exited")}</div>
              <Button size="small" onClick={() => void props.device.start(props.platform)}>
                {language.t("session.device.restart")}
              </Button>
            </div>
          </Match>
          <Match when={true}>
            <div class="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
              <div class="text-12-regular text-text-weak">
                {props.detected.length === 0 && props.device.info()
                  ? language.t("session.device.status.notDetected")
                  : language.t("session.device.status.stopped")}
              </div>
              <Button
                size="small"
                disabled={!props.device.info()}
                onClick={() => void props.device.start(props.platform)}
              >
                {language.t("session.device.start")}
              </Button>
            </div>
          </Match>
        </Switch>
        <Show when={showLog() && log()}>
          <pre class="absolute inset-x-0 bottom-0 max-h-56 overflow-auto px-3 py-2 whitespace-pre-wrap text-11-regular text-text-weak bg-background-stronger border-t border-border-weaker-base select-text">
            {log()}
          </pre>
        </Show>
        <Show when={build()?.error && !showLog()}>
          {(error) => (
            <div class="absolute inset-x-0 bottom-0 px-3 py-2 text-11-regular text-text-danger-base bg-background-stronger border-t border-border-weaker-base truncate">
              {error()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
