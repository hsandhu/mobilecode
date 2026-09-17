import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createEffect } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { createDeviceState, deviceFrameworkIcon, devicePreviewIcon } from "./device-state"

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

function RunControl(props: {
  icon: "react" | "xcode" | "android-studio"
  title: string
  stoppable: boolean
  pending: boolean
  onRun: () => void
  onStop: () => void
}) {
  return (
    <Tooltip value={props.title} placement="bottom" class="flex items-center">
      <button
        type="button"
        aria-label={props.title}
        disabled={props.pending}
        aria-busy={props.pending}
        class="flex h-6 box-border shrink-0 items-center gap-1 rounded-md border border-border-weak-base bg-surface-panel pl-1.5 pr-1 text-text-strong hover:bg-surface-raised-base-hover"
        onClick={() => (props.stoppable ? props.onStop() : props.onRun())}
      >
        <AppIcon id={props.icon} class="size-4 shrink-0" />
        <Show when={props.stoppable} fallback={<PlayGlyph />}>
          <StopGlyph />
        </Show>
      </button>
    </Tooltip>
  )
}

/**
 * Independent Metro, iOS and Android controls in the review panel toolbar. Progress and errors
 * live in the device pane, so each control stays a compact contextual play/stop button.
 */
export function SessionDeviceRun() {
  const language = useLanguage()
  const device = createDeviceState()

  const label = (platform: DevicePreview.Platform) =>
    platform === "ios" ? language.t("session.device.platform.ios") : language.t("session.device.platform.android")
  const bundlerStoppable = () => {
    const status = device.info()?.bundler?.status
    return status === "starting" || status === "running"
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
        <Show when={deviceFrameworkIcon(device.info()?.framework)}>
          {(icon) => (
            <RunControl
              icon={icon()}
              title={language.t(bundlerStoppable() ? "session.device.stop" : "session.device.start")}
              stoppable={bundlerStoppable()}
              pending={device.pending("metro")}
              onRun={() => void device.startBundler()}
              onStop={() => void device.stopBundler()}
            />
          )}
        </Show>
        <For each={device.platforms()}>
          {(platform) => (
            <RunControl
              icon={devicePreviewIcon(platform)}
              title={language.t(device.stoppable(platform) ? "session.device.run.stop" : "session.device.run.play", {
                platform: label(platform),
              })}
              stoppable={device.stoppable(platform)}
              pending={device.pending(platform)}
              onRun={() => void device.runApp(platform)}
              onStop={() => void device.stopApp(platform)}
            />
          )}
        </For>
      </div>
    </Show>
  )
}
