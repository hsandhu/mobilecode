import { For, Show } from "solid-js"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { AppIcon } from "@opencode/ui/app-icon"
import { Tooltip } from "@opencode/ui/tooltip"
import type definition from "./index"
import { deviceAppStoppable, deviceBundlerStoppable } from "./machine"
import type { DeviceModel } from "./model"
import { deviceFrameworkIcon, devicePlatformIcon } from "./preview"

/**
 * Metro, iOS and Android play and stop controls at the end of the side region's tab strip, and a shortcut to the
 * device tab while it is closed. Progress and errors live in the device tab, so each control stays one compact button.
 */
export default function DeviceControls(props: {
  device: DeviceModel
  session: MountedSession
  /** The device tab is in the strip. */
  opened: boolean
  onOpen: () => void
}) {
  const ctx = usePlugin<typeof definition>()
  const info = () => props.device.info(props.session)
  const platforms = () => info()?.platforms ?? []

  return (
    <Show when={platforms().length > 0}>
      <div class="flex items-center gap-2" data-component="device-run">
        <Show when={deviceFrameworkIcon(info()?.framework)}>
          {(icon) => (
            <RunControl
              icon={icon()}
              title={ctx.t(deviceBundlerStoppable(info()) ? "stop" : "start")}
              stoppable={deviceBundlerStoppable(info())}
              pending={props.device.pending("metro")}
              onRun={() => props.device.request({ kind: "bundler.start" })}
              onStop={() => props.device.request({ kind: "bundler.stop" })}
            />
          )}
        </Show>
        <For each={platforms()}>
          {(platform) => (
            <RunControl
              icon={devicePlatformIcon(platform)}
              title={ctx.t(deviceAppStoppable(info(), platform) ? "run.stop" : "run.play", {
                platform: props.device.platformLabel(platform),
              })}
              stoppable={deviceAppStoppable(info(), platform)}
              pending={props.device.pending(platform)}
              onRun={() => props.device.request({ kind: "run", platform })}
              onStop={() => props.device.request({ kind: "stop", platform })}
            />
          )}
        </For>
        <Show when={!props.opened && platforms()[0]}>
          {(platform) => (
            <Tooltip value={ctx.t("command.toggle")} placement="bottom" class="flex items-center">
              <button
                type="button"
                aria-label={ctx.t("command.toggle")}
                class="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-v2-background-bg-layer-02"
                onClick={() => props.onOpen()}
              >
                <AppIcon id={devicePlatformIcon(platform())} class="size-4 shrink-0" />
              </button>
            </Tooltip>
          )}
        </Show>
      </div>
    </Show>
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
        class="flex h-6 box-border shrink-0 items-center gap-1 rounded-md border border-v2-border-border-base pl-1.5 pr-1 text-v2-text-text-base hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
        onClick={() => (props.stoppable ? props.onStop() : props.onRun())}
      >
        <AppIcon id={props.icon} class="size-4 shrink-0" />
        <Show
          when={props.stoppable}
          fallback={
            <svg viewBox="0 0 16 16" class="size-[14px] shrink-0" aria-hidden="true">
              <path d="M4.5 3.2 12.5 8l-8 4.8V3.2Z" fill="currentColor" />
            </svg>
          }
        >
          <svg viewBox="0 0 16 16" class="size-[14px] shrink-0" aria-hidden="true">
            <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
          </svg>
        </Show>
      </button>
    </Tooltip>
  )
}
