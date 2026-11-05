import type { DevicePreview } from "@opencode/schema/device-preview"

export type DevicePlatform = DevicePreview.Platform

/** What one run control acts on: a platform's app, or the Metro bundler both apps share. */
export type DeviceControl = DevicePlatform | "metro"

/** A user action on the routed session's directory. */
export type DeviceRequest =
  | { readonly kind: "run"; readonly platform: DevicePlatform }
  | { readonly kind: "stop"; readonly platform: DevicePlatform }
  | { readonly kind: "bundler.start" }
  | { readonly kind: "bundler.stop" }

/** Polls this often while Metro, a preview server or a build is live. */
export const DEVICE_ACTIVE_POLL_MS = 1_500

/** Polls this often otherwise, so a project the agent creates or a run it starts still shows. */
export const DEVICE_IDLE_POLL_MS = 8_000

/** How long `get` may take before the poll counts as failed. */
export const DEVICE_FETCH_TIMEOUT_MS = 15_000

/** How long a run, stop or bundler change may take before its control frees up again. */
export const DEVICE_ACTION_TIMEOUT_MS = 60_000

/** The routed session's directory on its server. Device state is per directory; auto-open is per session. */
export type DeviceTarget = { readonly key: string; readonly serverID: string; readonly directory: string }

/** The last failed request: the server's message, or none when it timed out. */
export type DeviceFailure = { readonly message: string | undefined }

type Memory = {
  readonly issued: number
  /** Sessions whose device tab already opened by itself for a detected project. */
  readonly opened: ReadonlySet<string>
  /** Builds whose start already opened the tab, as `${platform}:${startedAt}` by session. */
  readonly seen: ReadonlyMap<string, ReadonlySet<string>>
}

export type DeviceState =
  /** No routed, connected session. */
  | ({ readonly status: "idle" } & Memory)
  /**
   * Polling the routed session's directory. Every request takes an attempt; only the newest (`latest`) may replace
   * `info`, so a slow poll never overwrites the "building" state a run just returned. One poll runs at a time, and
   * none while an action is in flight: the action's answer is newer.
   */
  | ({
      readonly status: "watching"
      readonly target: DeviceTarget
      readonly info: DevicePreview.Info | undefined
      readonly failure: DeviceFailure | undefined
      readonly latest: number
      readonly poll: { readonly phase: "fetching" | "waiting"; readonly attempt: number } | undefined
      /** The one action in flight per control. */
      readonly actions: ReadonlyMap<DeviceControl, number>
    } & Memory)
  | { readonly status: "disposed" }

export type DeviceEvent =
  | { readonly type: "target.attached"; readonly target: DeviceTarget }
  | { readonly type: "target.detached" }
  | { readonly type: "fetch.succeeded"; readonly attempt: number; readonly info: DevicePreview.Info }
  /** `get` rejected with `message`, or timed out (no message). */
  | { readonly type: "fetch.failed"; readonly attempt: number; readonly message?: string }
  | { readonly type: "poll.due"; readonly attempt: number }
  | { readonly type: "action.requested"; readonly request: DeviceRequest }
  | {
      readonly type: "action.succeeded"
      readonly attempt: number
      readonly control: DeviceControl
      readonly info: DevicePreview.Info
    }
  /** The action rejected with `message`, or timed out (no message). */
  | {
      readonly type: "action.failed"
      readonly attempt: number
      readonly control: DeviceControl
      readonly message?: string
    }
  /** The sessions of open shell tabs, plus the routed one; auto-open forgets the rest. */
  | { readonly type: "sessions.pruned"; readonly keep: ReadonlySet<string> }
  | { readonly type: "disposed" }

export type DeviceEffect =
  | { readonly type: "fetch"; readonly attempt: number; readonly serverID: string; readonly directory: string }
  | {
      readonly type: "action"
      readonly attempt: number
      readonly control: DeviceControl
      readonly serverID: string
      readonly directory: string
      readonly request: DeviceRequest
    }
  | { readonly type: "schedule"; readonly attempt: number; readonly delay: number }
  /** Stops the fetch, timer or action of `attempt`; its result, if any, is ignored. */
  | { readonly type: "cancel"; readonly attempt: number }
  /** Opens the device tab of session `key`, if it is still routed. */
  | { readonly type: "open"; readonly key: string }
  /** A build moved into failure while the session was shown. */
  | { readonly type: "toast.failed"; readonly platform: DevicePlatform; readonly error: string | undefined }

export type DeviceTransition = { readonly state: DeviceState; readonly effects: readonly DeviceEffect[] }

type Watching = Extract<DeviceState, { status: "watching" }>

type Idle = Extract<DeviceState, { status: "idle" }>

type WatchingTransition = { readonly state: Watching; readonly effects: readonly DeviceEffect[] }

type IdleTransition = { readonly state: Idle; readonly effects: readonly DeviceEffect[] }

const NONE: readonly DeviceEffect[] = []

export function createDeviceState(): DeviceState {
  return { status: "idle", issued: 0, opened: new Set(), seen: new Map() }
}

export function transitionDevice(state: DeviceState, event: DeviceEvent): DeviceTransition {
  if (state.status === "disposed") return { state, effects: NONE }

  if (event.type === "disposed") return { state: { status: "disposed" }, effects: leave(state).effects }

  if (event.type === "target.attached") return attach(state, event.target)

  if (event.type === "target.detached") return state.status === "idle" ? { state, effects: NONE } : leave(state)

  if (event.type === "sessions.pruned") return prune(state, event.keep)

  if (state.status === "idle") return { state, effects: NONE }

  if (event.type === "fetch.succeeded" || event.type === "fetch.failed") {
    if (state.poll?.phase !== "fetching" || state.poll.attempt !== event.attempt) return { state, effects: NONE }

    const settled: WatchingTransition =
      event.type === "fetch.succeeded"
        ? apply(state, event.attempt, event.info)
        : { state: { ...state, failure: { message: event.message } }, effects: NONE }

    return schedule({ ...settled.state, poll: undefined }, settled.effects)
  }

  if (event.type === "poll.due") {
    if (state.poll?.phase !== "waiting" || state.poll.attempt !== event.attempt) return { state, effects: NONE }
    const attempt = state.issued + 1

    return {
      state: { ...state, issued: attempt, latest: attempt, poll: { phase: "fetching", attempt } },
      effects: [{ type: "fetch", attempt, serverID: state.target.serverID, directory: state.target.directory }],
    }
  }

  if (event.type === "action.requested") {
    const control = controlOf(event.request)

    // A second click while the first is in flight would race it on the server.
    if (state.actions.has(control)) return { state, effects: NONE }
    const attempt = state.issued + 1

    return {
      state: {
        ...state,
        issued: attempt,
        latest: attempt,
        poll: undefined,
        actions: new Map(state.actions).set(control, attempt),
      },
      effects: [
        ...(state.poll ? [{ type: "cancel" as const, attempt: state.poll.attempt }] : []),
        {
          type: "action",
          attempt,
          control,
          serverID: state.target.serverID,
          directory: state.target.directory,
          request: event.request,
        },
      ],
    }
  }

  if (state.actions.get(event.control) !== event.attempt) return { state, effects: NONE }
  const actions = new Map(state.actions)
  actions.delete(event.control)

  // An action's own failure always shows, even when a newer request already answered.
  const settled: WatchingTransition =
    event.type === "action.succeeded"
      ? apply({ ...state, actions }, event.attempt, event.info)
      : { state: { ...state, actions, failure: { message: event.message } }, effects: NONE }

  return schedule(settled.state, settled.effects)
}

/** The routed session's device state, while its directory is watched. */
export function selectDeviceInfo(state: DeviceState, key: string) {
  if (state.status !== "watching" || state.target.key !== key) return

  return state.info
}

/** The routed session's last failed request, cleared by the next answer. */
export function selectDeviceFailure(state: DeviceState, key: string) {
  if (state.status !== "watching" || state.target.key !== key) return

  return state.failure
}

/** Whether an action on `control` is in flight; its controls wait meanwhile. */
export function selectDevicePending(state: DeviceState, control: DeviceControl) {
  return state.status === "watching" && state.actions.has(control)
}

/** A build that is still on its way to the device. */
export function deviceBuildBusy(build: DevicePreview.Build | undefined) {
  return build?.status === "building" || build?.status === "installing" || build?.status === "launching"
}

/** Whether the platform's control stops rather than runs: a build, run, device or preview server is live. */
export function deviceAppStoppable(info: DevicePreview.Info | undefined, platform: DevicePlatform) {
  const build = info?.builds.find((item) => item.platform === platform)

  return (
    deviceBuildBusy(build) ||
    build?.status === "running" ||
    !!build?.device ||
    !!info?.servers.some((item) => item.platform === platform && item.status !== "exited")
  )
}

/** Whether Metro's control stops rather than starts. */
export function deviceBundlerStoppable(info: DevicePreview.Info | undefined) {
  const status = info?.bundler?.status

  return status === "starting" || status === "running"
}

function attach(state: Exclude<DeviceState, { status: "disposed" }>, target: DeviceTarget): DeviceTransition {
  if (
    state.status === "watching" &&
    state.target.key === target.key &&
    state.target.serverID === target.serverID &&
    state.target.directory === target.directory
  )
    return { state, effects: NONE }
  const left = leave(state)
  const attempt = left.state.issued + 1

  return {
    state: {
      ...left.state,
      status: "watching",
      issued: attempt,
      target,
      info: undefined,
      failure: undefined,
      latest: attempt,
      poll: { phase: "fetching", attempt },
      actions: new Map(),
    },
    effects: [...left.effects, { type: "fetch", attempt, serverID: target.serverID, directory: target.directory }],
  }
}

// Leaving a directory ends its poll and every action in flight; nothing it answers applies any more.
function leave(state: Exclude<DeviceState, { status: "disposed" }>): IdleTransition {
  const idle: Idle = { status: "idle", issued: state.issued, opened: state.opened, seen: state.seen }

  if (state.status === "idle") return { state: idle, effects: NONE }

  return {
    state: idle,
    effects: [
      ...(state.poll ? [state.poll.attempt] : []),
      ...state.actions.values(),
    ].map((attempt): DeviceEffect => ({ type: "cancel", attempt })),
  }
}

// Applies an answer when it is the newest request. Opens the tab the first time a session shows a mobile project and
// whenever a new build starts, which is how a run the agent started becomes visible; closing the tab keeps it closed
// until the next build. A build that moves into failure is announced, never one that had already failed.
function apply(state: Watching, attempt: number, info: DevicePreview.Info): WatchingTransition {
  if (attempt !== state.latest) return { state, effects: NONE }
  const key = state.target.key
  const previous = state.info
  const first = info.platforms.length > 0 && !state.opened.has(key)

  const seen = state.seen.get(key)

  const fresh = info.builds.flatMap((build) =>
    deviceBuildBusy(build) && build.startedAt !== undefined && !seen?.has(`${build.platform}:${build.startedAt}`)
      ? [`${build.platform}:${build.startedAt}`]
      : [],
  )

  const failed = previous
    ? info.builds.filter(
        (build) =>
          build.status === "failed" &&
          previous.builds.find((item) => item.platform === build.platform)?.status !== "failed",
      )
    : []

  return {
    state: {
      ...state,
      info,
      failure: undefined,
      opened: first ? new Set(state.opened).add(key) : state.opened,
      seen: fresh.length > 0 ? new Map(state.seen).set(key, new Set([...(seen ?? []), ...fresh])) : state.seen,
    },
    effects: [
      ...(first || fresh.length > 0 ? [{ type: "open" as const, key }] : []),
      ...failed.map((build): DeviceEffect => ({ type: "toast.failed", platform: build.platform, error: build.error })),
    ],
  }
}

// Waits for the next poll once nothing else is in flight: soon while something is live, slowly otherwise.
function schedule(state: Watching, effects: readonly DeviceEffect[]): DeviceTransition {
  if (state.poll || state.actions.size > 0) return { state, effects }
  const attempt = state.issued + 1

  return {
    state: { ...state, issued: attempt, poll: { phase: "waiting", attempt } },
    effects: [...effects, { type: "schedule", attempt, delay: live(state.info) ? DEVICE_ACTIVE_POLL_MS : DEVICE_IDLE_POLL_MS }],
  }
}

function prune(state: Exclude<DeviceState, { status: "disposed" }>, keep: ReadonlySet<string>): DeviceTransition {
  const kept = (key: string) => keep.has(key) || (state.status === "watching" && key === state.target.key)
  const opened = [...state.opened].filter(kept)
  const seen = [...state.seen].filter(([key]) => kept(key))

  if (opened.length === state.opened.size && seen.length === state.seen.size) return { state, effects: NONE }

  return { state: { ...state, opened: new Set(opened), seen: new Map(seen) }, effects: NONE }
}

function live(info: DevicePreview.Info | undefined) {
  if (!info) return false

  return (
    info.bundler?.status === "starting" ||
    info.bundler?.status === "running" ||
    info.servers.some((item) => item.status !== "exited") ||
    info.builds.some(deviceBuildBusy)
  )
}

function controlOf(request: DeviceRequest): DeviceControl {
  if (request.kind === "run" || request.kind === "stop") return request.platform

  return "metro"
}
