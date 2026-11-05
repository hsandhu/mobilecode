import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DevicePreview } from "@opencode/schema/device-preview"
import {
  createDeviceState,
  DEVICE_ACTIVE_POLL_MS,
  DEVICE_IDLE_POLL_MS,
  deviceAppStoppable,
  selectDeviceFailure,
  selectDeviceInfo,
  selectDevicePending,
  transitionDevice,
  type DeviceEffect,
  type DeviceEvent,
  type DeviceState,
} from "./machine"

// The server's answer, decoded as the wire carries it.
const decode = Schema.decodeUnknownSync(DevicePreview.Info)

const idle = decode({ platforms: ["ios", "android"], framework: "expo", servers: [], builds: [] })

const none = decode({ platforms: [], servers: [], builds: [] })

const building = (startedAt: number) =>
  decode({
    platforms: ["ios", "android"],
    framework: "expo",
    servers: [],
    builds: [{ platform: "ios", status: "building", log: [], startedAt }],
  })

const failed = decode({
  platforms: ["ios", "android"],
  framework: "expo",
  servers: [],
  builds: [{ platform: "ios", status: "failed", error: "xcodebuild exited with 65", log: [] }],
})

const s1 = { key: "srv\nses_1", serverID: "srv", directory: "/repo" }

const s2 = { key: "srv\nses_2", serverID: "srv", directory: "/other" }

// Replays events through the pure machine and collects every effect it asked for, in order.
function play(state: DeviceState, ...events: DeviceEvent[]) {
  return events.reduce<{ state: DeviceState; effects: readonly DeviceEffect[] }>(
    (result, event) => {
      const next = transitionDevice(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state, effects: [] },
  )
}

const attempts = (effects: readonly DeviceEffect[], type: DeviceEffect["type"]) =>
  effects.flatMap((effect) => (effect.type === type && "attempt" in effect ? [effect.attempt] : []))

// S1 routed with its first answer applied: fetch 1, then poll timer 2.
function watched(info = idle) {
  return play(
    createDeviceState(),
    { type: "target.attached", target: s1 },
    { type: "fetch.succeeded", attempt: 1, info },
  ).state
}

describe("device polling", () => {
  test("polls slowly while nothing is live and soon while a build runs", () => {
    const first = play(
      createDeviceState(),
      { type: "target.attached", target: s1 },
      { type: "fetch.succeeded", attempt: 1, info: idle },
    )

    expect(first.effects).toContainEqual({ type: "fetch", attempt: 1, serverID: "srv", directory: "/repo" })
    expect(first.effects).toContainEqual({ type: "schedule", attempt: 2, delay: DEVICE_IDLE_POLL_MS })
    expect(selectDeviceInfo(first.state, s1.key)).toEqual(idle)

    const next = play(first.state, { type: "poll.due", attempt: 2 }, { type: "fetch.succeeded", attempt: 3, info: building(5) })

    expect(next.effects).toContainEqual({ type: "fetch", attempt: 3, serverID: "srv", directory: "/repo" })
    expect(next.effects).toContainEqual({ type: "schedule", attempt: 4, delay: DEVICE_ACTIVE_POLL_MS })
  })

  test("a failed poll keeps the last answer, shows the failure, and polls again", () => {
    const result = play(watched(), { type: "poll.due", attempt: 2 }, { type: "fetch.failed", attempt: 3 })

    expect(selectDeviceInfo(result.state, s1.key)).toEqual(idle)
    expect(selectDeviceFailure(result.state, s1.key)).toEqual({ message: undefined })
    expect(attempts(result.effects, "schedule")).toEqual([4])

    const recovered = play(result.state, { type: "poll.due", attempt: 4 }, { type: "fetch.succeeded", attempt: 5, info: idle })

    expect(selectDeviceFailure(recovered.state, s1.key)).toBeUndefined()
  })

  test("a slow poll never overwrites the state a run just returned", () => {
    // The poll is in flight when the user presses play.
    const result = play(
      watched(),
      { type: "poll.due", attempt: 2 },
      { type: "action.requested", request: { kind: "run", platform: "ios" } },
    )

    expect(result.effects).toContainEqual({ type: "cancel", attempt: 3 })
    expect(result.effects).toContainEqual({
      type: "action",
      attempt: 4,
      control: "ios",
      serverID: "srv",
      directory: "/repo",
      request: { kind: "run", platform: "ios" },
    })
    expect(selectDevicePending(result.state, "ios")).toBe(true)

    const settled = play(
      result.state,
      { type: "action.succeeded", attempt: 4, control: "ios", info: building(9) },
      // The cancelled poll answers late with the state from before the run.
      { type: "fetch.succeeded", attempt: 3, info: idle },
    )

    expect(selectDeviceInfo(settled.state, s1.key)).toEqual(building(9))
    expect(selectDevicePending(settled.state, "ios")).toBe(false)
    expect(settled.effects).toContainEqual({ type: "schedule", attempt: 5, delay: DEVICE_ACTIVE_POLL_MS })
  })

  test("a second press while the control waits is ignored; other controls run alongside", () => {
    const result = play(
      watched(),
      { type: "action.requested", request: { kind: "run", platform: "ios" } },
      { type: "action.requested", request: { kind: "run", platform: "ios" } },
      { type: "action.requested", request: { kind: "bundler.start" } },
    )

    expect(attempts(result.effects, "action")).toEqual([3, 4])
    expect(selectDevicePending(result.state, "metro")).toBe(true)

    // The older run answers after Metro: its control frees up, but only the newest answer shows.
    const settled = play(
      result.state,
      { type: "action.succeeded", attempt: 4, control: "metro", info: idle },
      { type: "action.succeeded", attempt: 3, control: "ios", info: building(1) },
    )

    expect(selectDevicePending(settled.state, "ios")).toBe(false)
    expect(selectDeviceInfo(settled.state, s1.key)).toEqual(idle)
    // One poll timer, once both are done.
    expect(attempts(settled.effects, "schedule")).toEqual([5])
  })

  test("an action's failure shows even when a newer request answered first, and a timeout has no message", () => {
    const result = play(
      watched(),
      { type: "action.requested", request: { kind: "stop", platform: "android" } },
      { type: "action.requested", request: { kind: "run", platform: "ios" } },
      { type: "action.succeeded", attempt: 4, control: "ios", info: idle },
      { type: "action.failed", attempt: 3, control: "android", message: "adb not found" },
    )

    expect(selectDeviceFailure(result.state, s1.key)).toEqual({ message: "adb not found" })

    const timedOut = play(
      result.state,
      { type: "action.requested", request: { kind: "bundler.stop" } },
      { type: "action.failed", attempt: 6, control: "metro" },
    )

    expect(selectDeviceFailure(timedOut.state, s1.key)).toEqual({ message: undefined })
    expect(selectDevicePending(timedOut.state, "metro")).toBe(false)
  })

  test("another session cancels the poll and every action, and their late answers are ignored", () => {
    const busy = play(watched(), { type: "action.requested", request: { kind: "run", platform: "ios" } })
    const moved = play(busy.state, { type: "target.attached", target: s2 })

    expect(moved.effects).toEqual([
      { type: "cancel", attempt: 3 },
      { type: "fetch", attempt: 4, serverID: "srv", directory: "/other" },
    ])
    expect(selectDeviceInfo(moved.state, s1.key)).toBeUndefined()
    expect(selectDevicePending(moved.state, "ios")).toBe(false)

    const late = play(moved.state, { type: "action.succeeded", attempt: 3, control: "ios", info: building(1) })

    expect(late.state).toBe(moved.state)
  })

  test("the same target attaching again changes nothing", () => {
    const state = watched()

    expect(transitionDevice(state, { type: "target.attached", target: { ...s1 } }).state).toBe(state)
  })

  test("detach and dispose cancel what runs, and a disposed machine ignores everything", () => {
    const busy = play(watched(), { type: "action.requested", request: { kind: "bundler.start" } }).state

    expect(transitionDevice(busy, { type: "target.detached" }).effects).toEqual([{ type: "cancel", attempt: 3 }])

    const disposed = play(watched(), { type: "disposed" })

    expect(disposed.effects).toEqual([{ type: "cancel", attempt: 2 }])
    expect(transitionDevice(disposed.state, { type: "target.attached", target: s1 }).effects).toEqual([])
  })
})

describe("device auto-open", () => {
  test("opens once when a session first shows a mobile project, not again after a switch and back", () => {
    const first = play(
      createDeviceState(),
      { type: "target.attached", target: s1 },
      { type: "fetch.succeeded", attempt: 1, info: idle },
    )

    expect(first.effects).toContainEqual({ type: "open", key: s1.key })

    const back = play(
      first.state,
      { type: "target.attached", target: s2 },
      { type: "fetch.succeeded", attempt: 3, info: none },
      { type: "target.attached", target: s1 },
      { type: "fetch.succeeded", attempt: 5, info: idle },
    )

    expect(back.effects.filter((effect) => effect.type === "open")).toEqual([])
  })

  test("opens again for each build that starts, once per build", () => {
    const result = play(
      watched(),
      { type: "poll.due", attempt: 2 },
      { type: "fetch.succeeded", attempt: 3, info: building(100) },
      { type: "poll.due", attempt: 4 },
      { type: "fetch.succeeded", attempt: 5, info: building(100) },
      { type: "poll.due", attempt: 6 },
      { type: "fetch.succeeded", attempt: 7, info: building(200) },
    )

    expect(result.effects.filter((effect) => effect.type === "open")).toHaveLength(2)
  })

  test("forgets sessions whose tab closed, so they open again", () => {
    const pruned = play(watched(), { type: "target.attached", target: s2 }, { type: "sessions.pruned", keep: new Set([s2.key]) })
    const again = play(pruned.state, { type: "target.attached", target: s1 }, { type: "fetch.succeeded", attempt: 4, info: idle })

    expect(again.effects).toContainEqual({ type: "open", key: s1.key })
  })

  test("a project without platforms never opens the tab", () => {
    expect(play(createDeviceState(), { type: "target.attached", target: s1 }, { type: "fetch.succeeded", attempt: 1, info: none }).effects).not.toContainEqual({ type: "open", key: s1.key })
  })
})

describe("device build failures", () => {
  test("announces a build that moves into failure", () => {
    const result = play(
      watched(building(1)),
      { type: "poll.due", attempt: 2 },
      { type: "fetch.succeeded", attempt: 3, info: failed },
    )

    expect(result.effects).toContainEqual({ type: "toast.failed", platform: "ios", error: "xcodebuild exited with 65" })

    // The next poll still reads failed: no second announcement.
    const again = play(result.state, { type: "poll.due", attempt: 4 }, { type: "fetch.succeeded", attempt: 5, info: failed })

    expect(again.effects.filter((effect) => effect.type === "toast.failed")).toEqual([])
  })

  test("never announces a failure that was there when the session opened", () => {
    const result = play(
      createDeviceState(),
      { type: "target.attached", target: s1 },
      { type: "fetch.succeeded", attempt: 1, info: failed },
    )

    expect(result.effects.filter((effect) => effect.type === "toast.failed")).toEqual([])
  })

  test("a failed build keeps its device stoppable until the user stops it", () => {
    const kept = decode({
      platforms: ["android"],
      servers: [],
      builds: [{ platform: "android", status: "failed", device: "Pixel_8", log: [] }],
    })

    expect(deviceAppStoppable(kept, "android")).toBe(true)
    expect(deviceAppStoppable(idle, "android")).toBe(false)
  })
})
