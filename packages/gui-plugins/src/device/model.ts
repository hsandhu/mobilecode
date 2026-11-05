import { createSignal, onCleanup, untrack } from "solid-js"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { DevicePreview } from "@opencode/schema/device-preview"
import { createKeyed, type SessionRef, type SetupContext } from "@opencode/plugin/gui"
import { showToast } from "@opencode/ui/toast"
import type Device from "./index"
import {
  createDeviceState,
  DEVICE_ACTION_TIMEOUT_MS,
  DEVICE_FETCH_TIMEOUT_MS,
  selectDeviceFailure,
  selectDeviceInfo,
  selectDevicePending,
  transitionDevice,
  type DeviceControl,
  type DeviceEffect,
  type DeviceEvent,
  type DevicePlatform,
  type DeviceRequest,
} from "./machine"

export type DeviceModel = ReturnType<typeof createDevice>

/**
 * Device detection, preview servers, Metro and builds for the routed session's directory: one poll the tab, its label,
 * the run controls and the command share, so they never disagree.
 */
export function createDevice(ctx: SetupContext<typeof Device>, key: string) {
  const [state, setState] = createSignal(createDeviceState())
  // Ends a fetch, poll timer or action by its attempt.
  const running = new Map<number, () => void>()

  const dispatch = (event: DeviceEvent) => {
    const next = transitionDevice(untrack(state), event)

    if (next.state !== untrack(state)) setState(next.state)
    next.effects.forEach((effect) => void Promise.try(() => run(effect)).catch(console.error))
  }

  const stop = (attempt: number) => {
    running.get(attempt)?.()
    running.delete(attempt)
  }

  const platformLabel = (platform: DevicePlatform) => ctx.t(platform === "ios" ? "platform.ios" : "platform.android")

  const run = (effect: DeviceEffect) => {
    if (effect.type === "cancel") return stop(effect.attempt)

    if (effect.type === "schedule") {
      const timer = setTimeout(() => {
        running.delete(effect.attempt)
        dispatch({ type: "poll.due", attempt: effect.attempt })
      }, effect.delay)

      running.set(effect.attempt, () => clearTimeout(timer))

      return
    }

    if (effect.type === "open") {
      const session = ctx.sessions.current()

      // The tab opens by itself only beside the conversation, never over it on a narrow screen.
      if (session?.key !== effect.key || ctx.layout.narrow()) return

      return ctx.layout.open(key, session, { tab: "select" })
    }

    if (effect.type === "toast.failed") {
      const title = ctx.t("run.failed")
      const detail = effect.error?.replace(/\.$/, "")

      return showToast({
        variant: "error",
        title,
        description: detail && detail !== title ? effect.error : platformLabel(effect.platform),
      })
    }

    // A restarted or re-authenticated server gets a new client under the same id.
    const client = ctx.servers.get(effect.serverID)?.client
    const location = { directory: effect.directory }
    const attempt = effect.attempt

    if (effect.type === "fetch")
      return guard(
        attempt,
        DEVICE_FETCH_TIMEOUT_MS,
        (signal) => available(client).devicePreview.get({ location }, { signal }),
        (info) => ({ type: "fetch.succeeded", attempt, info }),
        (message) => ({ type: "fetch.failed", attempt, message }),
      )

    const control = effect.control

    guard(
      attempt,
      DEVICE_ACTION_TIMEOUT_MS,
      (signal) => request(available(client), effect.request, location, signal),
      (info) => ({ type: "action.succeeded", attempt, control, info }),
      (message) => ({ type: "action.failed", attempt, control, message }),
    )
  }

  // Runs one request under `attempt` and settles it once: its answer, its error, or its timeout (no message).
  const guard = (
    attempt: number,
    timeout: number,
    send: (signal: AbortSignal) => Promise<{ data: DevicePreview.Info }>,
    done: (info: DevicePreview.Info) => DeviceEvent,
    failed: (message?: string) => DeviceEvent,
  ) => {
    const controller = new AbortController()

    const timer = setTimeout(() => {
      controller.abort()
      running.delete(attempt)
      dispatch(failed())
    }, timeout)

    running.set(attempt, () => {
      controller.abort()
      clearTimeout(timer)
    })

    const settle = (event: DeviceEvent) => {
      if (controller.signal.aborted) return
      clearTimeout(timer)
      running.delete(attempt)
      dispatch(event)
    }

    void Promise.try(() => send(controller.signal)).then(
      (response) => settle(done(response.data)),
      (cause: unknown) => settle(failed(cause instanceof Error ? cause.message : String(cause))),
    )
  }

  // Watches the routed session's directory. It attaches again when another session is routed, the session moves, or
  // its server reconnects.
  createKeyed(
    () => {
      const session = ctx.sessions.current()

      if (!session?.id || !session.server.connected) return

      return { key: session.key, serverID: session.server.id, directory: session.directory }
    },
    (target) => dispatch({ type: "target.attached", target }),
    {
      otherwise: () => dispatch({ type: "target.detached" }),
      equals: (a, b) => a.key === b.key && a.serverID === b.serverID && a.directory === b.directory,
    },
  )

  // Forgets which sessions already opened the tab once their shell tab closed.
  createKeyed(
    () => [...ctx.sessions.list().map((session) => session.key), ctx.sessions.current()?.key].join("\u0000"),
    () =>
      dispatch({
        type: "sessions.pruned",
        keep: new Set(
          [...ctx.sessions.list().map((session) => session.key), ctx.sessions.current()?.key].filter(
            (item): item is string => item !== undefined,
          ),
        ),
      }),
  )
  onCleanup(() => dispatch({ type: "disposed" }))

  return {
    /** The session's device state; undefined until the first answer, or while another session is routed. */
    info: (session: SessionRef) => selectDeviceInfo(state(), session.key),
    /** The session's last failed request, cleared by the next answer. */
    failure: (session: SessionRef) => selectDeviceFailure(state(), session.key),
    /** An action on `control` is in flight. */
    pending: (control: DeviceControl) => selectDevicePending(state(), control),
    /** Runs, stops, or starts or stops Metro, in the routed session's directory. */
    request: (request: DeviceRequest) => dispatch({ type: "action.requested", request }),
    platformLabel,
  }
}

function available(client: OpenCodeClient | undefined) {
  if (!client) throw new Error("server unavailable")

  return client
}

function request(client: OpenCodeClient, request: DeviceRequest, location: { directory: string }, signal: AbortSignal) {
  if (request.kind === "run")
    return client.devicePreview.runApp({ location, platform: request.platform }, { signal })

  if (request.kind === "stop")
    return client.devicePreview.stopApp({ location, platform: request.platform }, { signal })

  if (request.kind === "bundler.start") return client.devicePreview.startBundler({ location }, { signal })

  return client.devicePreview.stopBundler({ location }, { signal })
}
