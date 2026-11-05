import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { Command, MenuItem, Slot, type ClosedPanelTab, type Plugin, type SessionRef } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import { AppIcon } from "@opencode/ui/app-icon"
import type definition from "./index"
import { createDevice } from "./model"
import { devicePlatformIcon } from "./preview"

/**
 * The iOS Simulator and Android Emulator beside the session: a device tab that streams each detected platform, play
 * and stop controls at the end of the tab strip, and a command that toggles the tab. The tab opens by itself the first
 * time a session shows a mobile project, and whenever a build starts.
 */
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const layout = ctx.layout
  const sessions = ctx.sessions
  const key = `${ctx.id}:main`
  const device = createDevice(ctx, key)
  const DevicePane = lazy(() => import("./pane"))
  const DeviceControls = lazy(() => import("./controls"))
  // The controls show in the tab strip of every session with a mobile project, so compile both while the app idles.
  onCleanup(
    onIdle(() => {
      void DevicePane.preload()
      void DeviceControls.preload()
    }),
  )

  const platforms = (session: SessionRef) => device.info(session)?.platforms ?? []

  const open = (session: SessionRef) => layout.open(key, session, { tab: "select" })

  // One tab object for every session, so a session switch never renders its trigger again.
  const tab: BuiltinPanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    label: (state) => (
      <div class="flex items-center gap-1.5">
        <Show when={platforms(state.session)[0]}>
          {(platform) => <AppIcon id={devicePlatformIcon(platform())} class="size-4 shrink-0" />}
        </Show>
        <span>{ctx.t("tab.title")}</span>
      </div>
    ),
  }

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    // Stored before plugins as "device".
    legacy: { device: "main" },
    // Two streams side by side need the room of a split diff, so the side region may take the wider share.
    get wide() {
      const session = sessions.current()

      return !!session && layout.state(key, session) === "visible" && platforms(session).length > 1
    },
    mobile: {
      get title() {
        return ctx.t("mobile.title")
      },
      order: 50,
      kind: "menu",
      icon: "monitor",
    },
    list: (input) => (input.open.includes("main") ? [tab] : []),
    closed: (): ClosedPanelTab => ({ icon: "monitor" }),
    render: (props) => (
      <Show when={props.session.key} keyed>
        <Suspense>
          <DevicePane device={device} session={props.session} />
        </Suspense>
      </Show>
    ),
  })

  ctx.add(Slot, {
    at: "session.panel.end",
    render: (input) => (
      <Suspense>
        <DeviceControls
          device={device}
          session={input.session}
          opened={layout.state(key, input.session) !== "closed"}
          onOpen={() => open(input.session)}
        />
      </Suspense>
    ),
  })

  ctx.add(Command, (): Command => {
    const session = sessions.current()

    return {
      id: "toggle",
      title: ctx.t("command.toggle"),
      group: ctx.t("command.category.view"),
      section: "session",
      keywords: "device ios android simulator emulator expo react native metro",
      // Offered for a detected mobile project, or to close a tab that is open.
      enabled: !!session && (platforms(session).length > 0 || layout.state(key, session) !== "closed"),
      run: () => {
        const current = sessions.current()

        if (current) layout.toggle(key, current)
      },
    }
  })

  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = sessions.current()

    if (!session || platforms(session).length === 0) return undefined

    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("tab.title"),
      icon: "monitor",
      keybind: `${ctx.id}.toggle`,
      opened: layout.state(key, session) !== "closed",
      order: 50,
      run: () => {
        const current = sessions.current()

        if (current) open(current)
      },
    }
  })
}

export default setup
