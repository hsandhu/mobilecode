import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createEffect, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { createDeviceState, deviceBuildBusy, deviceFrameworkIcon, devicePreviewIcon } from "./device-state"

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" class="size-[14px] shrink-0" aria-hidden="true">
      <path d="M4.5 3.2 12.5 8l-8 4.8V3.2Z" fill="currentColor" />
    </svg>
  )
}

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" class="size-[14px] shrink-0" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  )
}

const control =
  "flex h-full items-center px-1.5 text-text-strong hover:bg-surface-raised-base-hover disabled:text-text-weaker disabled:hover:bg-transparent disabled:cursor-default"

/**
 * Metro status for React Native and Expo projects: the apps load their JavaScript from it, so
 * a rebuild is pointless while it is down. One dot, coloured by state, with the detail on hover.
 */
function BundlerIndicator(props: { bundler: DevicePreview.Bundler | undefined }) {
  const language = useLanguage()
  const status = () => props.bundler?.status
  const title = () => {
    const value = props.bundler
    if (!value) return language.t("session.device.bundler.idle")
    if (value.status === "running") return language.t("session.device.bundler.running", { url: value.url ?? "" })
    if (value.status === "exited") return language.t("session.device.bundler.exited")
    return language.t("session.device.bundler.starting")
  }
  return (
    <Tooltip value={title()} placement="bottom" class="flex items-center">
      <div
        class="flex h-6 box-border shrink-0 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel px-2 text-11-regular text-text-weak cursor-default"
        data-component="device-bundler"
        aria-label={title()}
      >
        <span
          class="size-2 shrink-0 rounded-full"
          classList={{
            "bg-icon-success-base": status() === "running",
            "bg-icon-warning-base animate-pulse": status() === "starting",
            "bg-icon-danger-base": status() === "exited",
            "bg-icon-weak-base": status() === undefined,
          }}
        />
        <span>{language.t("session.device.bundler.label")}</span>
      </div>
    </Tooltip>
  )
}

/**
 * One run control for the review panel toolbar. Play builds, installs and launches on every
 * detected platform at once; stop cancels the builds or terminates the running apps. Progress and
 * errors live in the device pane, so this stays a single Xcode-style pill.
 */
export function SessionDeviceRun() {
  const language = useLanguage()
  const device = createDeviceState()

  const label = (platform: DevicePreview.Platform) =>
    platform === "ios" ? language.t("session.device.platform.ios") : language.t("session.device.platform.android")
  const busy = (platform: DevicePreview.Platform) => deviceBuildBusy(device.build(platform))
  const stoppable = (platform: DevicePreview.Platform) => {
    const build = device.build(platform)
    return build?.status === "running" || deviceBuildBusy(build)
  }
  const anyStoppable = createMemo(() => device.platforms().some(stoppable))
  const allBusy = createMemo(() => device.platforms().every(busy))
  const icon = createMemo(() => deviceFrameworkIcon(device.info()?.framework))
  const single = createMemo(() => (device.platforms().length === 1 ? device.platforms()[0] : undefined))
  const playTitle = () => {
    const platform = single()
    return platform
      ? language.t("session.device.run.play", { platform: label(platform) })
      : language.t("session.device.run.playAll")
  }
  const stopTitle = () => {
    const platform = single()
    return platform
      ? language.t("session.device.run.stop", { platform: label(platform) })
      : language.t("session.device.run.stopAll")
  }

  // A build can fail in well under a second and the pane may be scrolled away, so announce the
  // transition into failure, but never the failure that was already there when the session opened.
  const seen = new Map<DevicePreview.Platform, DevicePreview.BuildStatus>()
  createEffect(() => {
    for (const platform of device.platforms()) {
      const build = device.build(platform)
      if (!build) continue
      const previous = seen.get(platform)
      seen.set(platform, build.status)
      if (build.status !== "failed" || previous === undefined || previous === "failed") continue
      const title = language.t("session.device.run.failed")
      const detail = build.error?.replace(/\.$/, "")
      showToast({
        variant: "error",
        title,
        description: detail && detail !== title ? build.error : label(platform),
      })
    }
  })

  return (
    <Show when={device.platforms().length > 0}>
      <div class="flex items-center gap-2" data-component="device-run">
        <Show when={icon()}>
          <BundlerIndicator bundler={device.info()?.bundler} />
        </Show>
        <div
          class="flex h-6 box-border shrink-0 items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden"
          data-component="device-run-control"
        >
          <div class="flex items-center pl-1.5 pr-0.5">
            <Show
              when={icon()}
              fallback={
                <div class="flex items-center -space-x-1">
                  <For each={device.platforms()}>
                    {(platform) => (
                      <AppIcon
                        id={devicePreviewIcon(platform)}
                        class="shrink-0"
                        style={{ width: single() ? "16px" : "14px", height: single() ? "16px" : "14px" }}
                      />
                    )}
                  </For>
                </div>
              }
            >
              {(value) => <AppIcon id={value()} class="shrink-0" style={{ width: "16px", height: "16px" }} />}
            </Show>
          </div>
          <Tooltip value={playTitle()} placement="bottom" class="flex h-full items-center">
            <button
              type="button"
              aria-label={playTitle()}
              disabled={allBusy()}
              class={control}
              onClick={() => {
                for (const platform of device.platforms()) if (!busy(platform)) void device.runApp(platform)
              }}
            >
              <PlayGlyph />
            </button>
          </Tooltip>
          <div class="h-3.5 w-px bg-border-weak-base" />
          <Tooltip value={stopTitle()} placement="bottom" class="flex h-full items-center">
            <button
              type="button"
              aria-label={stopTitle()}
              disabled={!anyStoppable()}
              class={control}
              onClick={() => {
                for (const platform of device.platforms()) if (stoppable(platform)) void device.stopApp(platform)
              }}
            >
              <StopGlyph />
            </button>
          </Tooltip>
        </div>
      </div>
    </Show>
  )
}
