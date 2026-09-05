import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { createDeviceState, deviceBuildBusy, devicePreviewIcon } from "./device-state"

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
      <path d="M4.5 3.2 12.5 8l-8 4.8V3.2Z" fill="currentColor" />
    </svg>
  )
}

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  )
}

/**
 * Xcode-style run control for the session titlebar: one button per detected platform plus the
 * current build status. Play builds, installs and launches; stop cancels or terminates the app.
 */
export function SessionDeviceRun() {
  const language = useLanguage()
  const device = createDeviceState()

  const label = (platform: DevicePreview.Platform) =>
    platform === "ios" ? language.t("session.device.platform.ios") : language.t("session.device.platform.android")

  // The platform worth describing is whichever is doing something, else the first detected.
  const active = createMemo(() => {
    const busy = device.platforms().find((platform) => {
      const build = device.build(platform)
      return deviceBuildBusy(build) || build?.status === "running" || build?.status === "failed"
    })
    return busy ?? device.platforms()[0]
  })

  const status = createMemo(() => {
    const platform = active()
    if (!platform) return
    const build = device.build(platform)
    if (!build) return
    if (build.status === "failed") return { text: build.error ?? language.t("session.device.run.failed"), failed: true }
    if (build.status === "running") return { text: language.t("session.device.run.running"), failed: false }
    if (deviceBuildBusy(build)) return { text: build.step ?? language.t("session.device.run.building"), failed: false }
  })

  return (
    <Show when={device.platforms().length > 0}>
      <div class="flex items-center gap-1.5" data-component="device-run">
        <Show when={status()}>
          {(value) => (
            <div class="hidden md:flex items-center gap-1.5 min-w-0">
              <Show when={!value().failed && deviceBuildBusy(device.build(active()))}>
                <Spinner class="size-3 shrink-0" />
              </Show>
              <span
                class="text-11-regular truncate max-w-[150px]"
                classList={{ "text-text-weak": !value().failed, "text-text-danger-base": value().failed }}
                title={value().text}
              >
                {value().text}
              </span>
            </div>
          )}
        </Show>
        <For each={device.platforms()}>
          {(platform) => {
            const build = () => device.build(platform)
            const running = () => build()?.status === "running"
            const busy = () => deviceBuildBusy(build())
            const stoppable = () => running() || busy()
            const title = () =>
              stoppable()
                ? language.t("session.device.run.stop", { platform: label(platform) })
                : language.t("session.device.run.play", { platform: label(platform) })
            return (
              <Tooltip value={title()} placement="bottom" class="flex items-center">
                <button
                  type="button"
                  aria-label={title()}
                  class="flex items-center gap-1 h-6 px-1.5 rounded-md hover:bg-surface-raised-base-hover cursor-default"
                  classList={{ "text-text-danger-base": stoppable(), "text-text-base": !stoppable() }}
                  onClick={() => {
                    if (stoppable()) {
                      void device.stopApp(platform)
                      return
                    }
                    void device.runApp(platform)
                  }}
                >
                  <AppIcon id={devicePreviewIcon(platform)} style={{ width: "14px", height: "14px" }} />
                  <Show when={stoppable()} fallback={<PlayGlyph />}>
                    <StopGlyph />
                  </Show>
                </button>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
