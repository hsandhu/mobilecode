import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { AppIcon } from "@opencode/ui/app-icon"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Spinner } from "@opencode/ui/spinner"
import type definition from "./index"
import { deviceAppStoppable, deviceBuildBusy, type DevicePlatform } from "./machine"
import type { DeviceModel } from "./model"
import { deviceFrameworkIcon, deviceMetroPath, devicePlatformIcon, devicePreviewUrl } from "./preview"

const ALL_PLATFORMS: readonly DevicePlatform[] = ["ios", "android"]

const LOG_TAIL = 40

// Two phone-shaped streams need at least this much before a split beats a toggle.
const SPLIT_MIN_WIDTH = 640

/**
 * The device tab: one preview per detected platform, side by side when there is room for both, otherwise one with a
 * platform toggle. Metro's status sits above them, since one bundler serves both apps.
 */
export default function DevicePane(props: { device: DeviceModel; session: MountedSession }) {
  const ctx = usePlugin<typeof definition>()
  const [width, setWidth] = createSignal(0)
  const [container, setContainer] = createSignal<HTMLDivElement>()
  const [store, setStore] = createStore<{ selected?: DevicePlatform; bundlerLog: boolean }>({ bundlerLog: false })
  createResizeObserver(container, (rect) => setWidth(rect.width))

  const info = () => props.device.info(props.session)
  const detected = () => info()?.platforms ?? []
  const options = () => (detected().length > 0 ? detected() : ALL_PLATFORMS)
  const selected = () => store.selected ?? options()[0]
  const split = () => detected().length > 1 && width() >= SPLIT_MIN_WIDTH
  const bundler = () => info()?.bundler

  const bundlerText = () => {
    const value = bundler()

    if (!value) return ""

    if (value.status === "running") return ctx.t("bundler.running", { url: value.url ?? "" })

    if (value.status === "exited") return ctx.t("bundler.exited")

    return ctx.t("bundler.starting")
  }

  const failure = () => {
    const value = props.device.failure(props.session)

    return value && (value.message ?? ctx.t("common.requestFailed"))
  }

  return (
    <div ref={setContainer} class="flex flex-col h-full min-h-0 bg-v2-background-bg-base">
      <Show when={bundler()}>
        {(value) => (
          <>
            <div class="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-v2-border-border-muted text-12-regular text-v2-text-text-muted">
              <Show when={value().status === "starting"}>
                <Spinner class="size-3 shrink-0" />
              </Show>
              <span class="min-w-0 flex-1 truncate" title={bundlerText()}>
                {bundlerText()}
              </span>
              <Button size="small" variant="ghost" onClick={() => setStore("bundlerLog", !store.bundlerLog)}>
                {ctx.t(store.bundlerLog ? "log.hide" : "log.show")}
              </Button>
            </div>
            <Show when={store.bundlerLog}>
              <pre class="max-h-40 shrink-0 overflow-auto px-3 py-2 whitespace-pre-wrap text-12-regular text-v2-text-text-muted bg-v2-background-bg-layer-01 border-b border-v2-border-border-muted select-text">
                {value().log.slice(-LOG_TAIL).join("\n")}
              </pre>
            </Show>
          </>
        )}
      </Show>
      <div class="relative flex flex-1 min-h-0">
        <Show
          when={info()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
              <Spinner class="size-4" />
              <div class="text-12-regular text-v2-text-text-muted">{ctx.t("status.loading")}</div>
            </div>
          }
        >
          <Show
            when={split()}
            fallback={
              <Show when={selected()} keyed>
                {(platform) => (
                  <Platform
                    device={props.device}
                    session={props.session}
                    platform={platform}
                    options={options()}
                    onSelect={(next) => setStore("selected", next)}
                    class="flex-1"
                  />
                )}
              </Show>
            }
          >
            <For each={detected()}>
              {(platform, index) => (
                <Platform
                  device={props.device}
                  session={props.session}
                  platform={platform}
                  class="flex-1 basis-0"
                  classList={{ "border-l border-v2-border-border-muted": index() > 0 }}
                />
              )}
            </For>
          </Show>
        </Show>
        <Show when={failure()}>
          {(message) => (
            <div class="absolute inset-x-0 bottom-0 px-3 py-2 text-12-regular text-v2-state-fg-danger bg-v2-background-bg-layer-01 border-t border-v2-border-border-muted">
              {message()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function Platform(props: {
  device: DeviceModel
  session: MountedSession
  platform: DevicePlatform
  /** With more than one entry, the header shows a platform toggle. */
  options?: readonly DevicePlatform[]
  onSelect?: (platform: DevicePlatform) => void
  class?: string
  classList?: Record<string, boolean | undefined>
}) {
  const ctx = usePlugin<typeof definition>()
  const [frame, setFrame] = createSignal<HTMLIFrameElement>()
  const [log, setLog] = createSignal(false)

  const info = () => props.device.info(props.session)
  const detected = () => info()?.platforms ?? []
  const server = () => info()?.servers.find((item) => item.platform === props.platform)
  const build = () => info()?.builds.find((item) => item.platform === props.platform)
  const url = createMemo(() => devicePreviewUrl(server()?.url, props.session.server.url))
  const streaming = () => server()?.status === "running" && !!url()
  const pending = () => props.device.pending(props.platform)
  const disabled = () => pending() || !detected().includes(props.platform)
  const label = (platform: DevicePlatform) => props.device.platformLabel(platform)
  const run = () => props.device.request({ kind: "run", platform: props.platform })

  // The build's own state takes the header while it matters; otherwise the stream's address.
  const progress = () => {
    const current = build()

    if (current && deviceBuildBusy(current)) return { text: current.step ?? ctx.t("run.building"), failed: false }

    if (current?.status === "failed") return { text: ctx.t("run.failed"), failed: true }

    if (current?.status === "running")
      return { text: `${ctx.t("run.running")} · ${current.appID ?? ""}`.trim(), failed: false }

    return { text: url() ?? server()?.command ?? "", failed: false }
  }

  // Both apps load their JavaScript from one Metro, so a native build that succeeded does not say which project's
  // bundle runs. Name Metro's project beside every live JavaScript run.
  const metro = () => {
    const current = build()
    const bundler = info()?.bundler

    if (!current || !bundler || bundler.status === "exited") return

    if (!deviceBuildBusy(current) && current.status !== "running") return

    if (!deviceFrameworkIcon(current.framework ?? info()?.framework)) return

    return { full: bundler.directory, short: deviceMetroPath(bundler.directory, props.session.directory) }
  }

  // Loads the stream again in place, as the simulator's own reload would.
  const reload = () => {
    const element = frame()
    const next = url()

    if (element && next) element.src = next
  }

  return (
    <div class={`flex flex-col h-full min-h-0 min-w-0 ${props.class ?? ""}`} classList={props.classList}>
      <div
        role="toolbar"
        aria-label={label(props.platform)}
        class="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-v2-border-border-muted"
      >
        <Show
          when={props.options && props.options.length > 1 ? props.options : undefined}
          fallback={
            <div class="flex items-center gap-1.5 text-12-medium text-v2-text-text-base">
              <AppIcon id={devicePlatformIcon(props.platform)} class="size-4 shrink-0" />
              <span>{label(props.platform)}</span>
            </div>
          }
        >
          {(options) => (
            <div class="flex items-center gap-1">
              <For each={options()}>
                {(platform) => (
                  <Button
                    size="small"
                    variant={props.platform === platform ? "neutral" : "ghost"}
                    onClick={() => props.onSelect?.(platform)}
                  >
                    <AppIcon id={devicePlatformIcon(platform)} class="size-3.5 shrink-0" />
                    {label(platform)}
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
              "text-v2-text-text-muted": !progress().failed,
              "text-v2-state-fg-danger": progress().failed,
            }}
            title={progress().text}
          >
            {progress().text}
          </span>
        </div>
        <Show when={build()}>
          <Button size="small" variant="ghost" onClick={() => setLog(!log())}>
            {ctx.t(log() ? "log.hide" : "log.show")}
          </Button>
        </Show>
        <Show when={streaming()}>
          <Button size="small" variant="ghost" onClick={reload}>
            {ctx.t("reload")}
          </Button>
          <IconButton
            icon={<Icon name="arrow-up-right" size="small" />}
            variant="ghost"
            title={ctx.t("openExternal")}
            aria-label={ctx.t("openExternal")}
            onClick={() => {
              const value = url()

              if (value) ctx.system.openExternal(value)
            }}
          />
        </Show>
        <Show
          when={deviceAppStoppable(info(), props.platform)}
          fallback={
            <Button size="small" disabled={disabled()} onClick={run}>
              {ctx.t("start")}
            </Button>
          }
        >
          <Button
            size="small"
            variant="ghost"
            disabled={disabled()}
            onClick={() => props.device.request({ kind: "stop", platform: props.platform })}
          >
            {ctx.t("stop")}
          </Button>
        </Show>
      </div>
      <Show when={metro()}>
        {(value) => (
          <div
            data-slot="device-metro"
            class="flex items-center gap-1.5 px-3 h-7 shrink-0 border-b border-v2-border-border-muted text-12-regular text-v2-text-text-muted"
          >
            <AppIcon id="react" class="size-3.5 shrink-0" />
            <span class="shrink-0">{ctx.t("bundler.label")}</span>
            <span class="min-w-0 truncate text-v2-text-text-base" title={value().full}>
              <bdi dir="ltr">{value().short}</bdi>
            </span>
          </div>
        )}
      </Show>
      <div class="relative flex-1 min-h-0">
        <Switch>
          <Match when={streaming()}>
            <iframe
              ref={setFrame}
              src={url()}
              title={label(props.platform)}
              class="absolute inset-0 w-full h-full border-0 bg-v2-background-bg-base"
              allow="clipboard-read; clipboard-write; fullscreen; autoplay"
              referrerpolicy="no-referrer"
            />
          </Match>
          <Match when={server()?.status === "starting"}>
            <Status spinner text={ctx.t("status.starting", { command: server()?.command ?? "" })} />
          </Match>
          <Match when={deviceBuildBusy(build()) || pending()}>
            <Status spinner text={progress().text} />
          </Match>
          <Match when={server()?.status === "exited"}>
            <Status text={ctx.t("status.exited")}>
              <Button size="small" disabled={disabled()} onClick={run}>
                {ctx.t("restart")}
              </Button>
            </Status>
          </Match>
          <Match when={true}>
            <Status text={ctx.t(detected().length === 0 ? "status.notDetected" : "status.stopped")}>
              <Button size="small" disabled={disabled()} onClick={run}>
                {ctx.t("start")}
              </Button>
            </Status>
          </Match>
        </Switch>
        <Show when={log() && build()}>
          {(current) => (
            <pre class="absolute inset-x-0 bottom-0 max-h-56 overflow-auto px-3 py-2 whitespace-pre-wrap text-12-regular text-v2-text-text-muted bg-v2-background-bg-layer-01 border-t border-v2-border-border-muted select-text">
              {current().log.slice(-LOG_TAIL).join("\n")}
            </pre>
          )}
        </Show>
        <Show when={!log() && build()?.error}>
          {(error) => (
            <div class="absolute inset-x-0 bottom-0 px-3 py-2 text-12-regular text-v2-state-fg-danger bg-v2-background-bg-layer-01 border-t border-v2-border-border-muted truncate">
              {error()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function Status(props: { text: string; spinner?: boolean; children?: JSX.Element }) {
  return (
    <div class="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <Show when={props.spinner}>
        <Spinner class="size-4" />
      </Show>
      <div class="text-12-regular text-v2-text-text-muted">{props.text}</div>
      {props.children}
    </div>
  )
}
