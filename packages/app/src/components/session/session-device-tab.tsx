import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Match, Show, Switch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { devicePreviewUrl } from "@/utils/device-preview"
import { createDeviceState, deviceBuildBusy, devicePreviewIcon } from "./device-state"

const ALL_PLATFORMS: DevicePreview.Platform[] = ["ios", "android"]
const LOG_TAIL = 40

export function SessionDeviceTab() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const device = createDeviceState()
  let frame: HTMLIFrameElement | undefined

  const [store, setStore] = createStore({
    selected: undefined as DevicePreview.Platform | undefined,
    started: {} as Partial<Record<DevicePreview.Platform, boolean>>,
    showLog: false,
  })

  const detected = createMemo(() => device.platforms())
  const options = createMemo(() => (detected().length > 0 ? detected() : ALL_PLATFORMS))
  const selected = createMemo(() => store.selected ?? options()[0])
  const server = createMemo(() => device.server(selected()))
  const build = createMemo(() => device.build(selected()))
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

  // Opening the pane for a detected platform starts its preview once. Stop stays respected.
  createEffect(() => {
    const value = selected()
    if (!value || !device.info() || store.started[value]) return
    setStore("started", value, true)
    if (!detected().includes(value) || device.server(value)) return
    void device.start(value)
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
    <div class="flex flex-col h-full min-h-0">
      <div class="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border-weaker-base">
        <Show
          when={options().length > 1}
          fallback={
            <Show when={selected()}>
              {(value) => (
                <div class="flex items-center gap-1.5 text-12-medium text-text-strong">
                  <AppIcon id={devicePreviewIcon(value())} style={{ width: "16px", height: "16px" }} />
                  <span>{label(value())}</span>
                </div>
              )}
            </Show>
          }
        >
          <div class="flex items-center gap-1">
            <For each={options()}>
              {(value) => (
                <Button
                  size="small"
                  variant={selected() === value ? "secondary" : "ghost"}
                  onClick={() => setStore("selected", value)}
                >
                  <AppIcon id={devicePreviewIcon(value)} style={{ width: "14px", height: "14px" }} />
                  {label(value)}
                </Button>
              )}
            </For>
          </div>
        </Show>
        <div class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{url() ?? server()?.command ?? ""}</div>
        <Show when={build()?.status === "failed" || deviceBuildBusy(build())}>
          <Button size="small" variant="ghost" onClick={() => setStore("showLog", !store.showLog)}>
            {store.showLog ? language.t("session.device.hideLog") : language.t("session.device.showLog")}
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
        <Show when={selected()}>
          {(value) => (
            <Show
              when={server() && server()!.status !== "exited"}
              fallback={
                <Button size="small" onClick={() => void device.start(value())}>
                  {language.t("session.device.start")}
                </Button>
              }
            >
              <Button size="small" variant="ghost" onClick={() => void device.stop(value())}>
                {language.t("session.device.stop")}
              </Button>
            </Show>
          )}
        </Show>
      </div>
      <div class="relative flex-1 min-h-0">
        <Switch>
          <Match when={running()}>
            <iframe
              ref={frame}
              src={url()}
              title={language.t("session.tab.device")}
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
              <Show when={selected()}>
                {(value) => (
                  <Button size="small" onClick={() => void device.start(value())}>
                    {language.t("session.device.restart")}
                  </Button>
                )}
              </Show>
            </div>
          </Match>
          <Match when={true}>
            <div class="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
              <div class="text-12-regular text-text-weak">
                {detected().length === 0 && device.info()
                  ? language.t("session.device.status.notDetected")
                  : language.t("session.device.status.stopped")}
              </div>
              <Show when={selected()}>
                {(value) => (
                  <Button size="small" disabled={!device.info()} onClick={() => void device.start(value())}>
                    {language.t("session.device.start")}
                  </Button>
                )}
              </Show>
            </div>
          </Match>
        </Switch>
        <Show when={store.showLog && log()}>
          <pre class="absolute inset-x-0 bottom-0 max-h-56 overflow-auto px-3 py-2 whitespace-pre-wrap text-11-regular text-text-weak bg-background-stronger border-t border-border-weaker-base select-text">
            {log()}
          </pre>
        </Show>
        <Show when={build()?.error && !store.showLog}>
          {(error) => (
            <div class="absolute inset-x-0 bottom-0 px-3 py-2 text-11-regular text-text-danger-base bg-background-stronger border-t border-border-weaker-base truncate">
              {error()}
            </div>
          )}
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
