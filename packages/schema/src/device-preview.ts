export * as DevicePreview from "./device-preview"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

export const Platform = Schema.Literals(["ios", "android"])
export type Platform = typeof Platform.Type

export const Status = Schema.Literals(["starting", "running", "exited"])
export type Status = typeof Status.Type

export interface Server extends Schema.Schema.Type<typeof Server> {}
export const Server = Schema.Struct({
  platform: Platform,
  status: Status,
  // Human-readable command line, e.g. `npx --yes serve-sim`.
  command: Schema.String,
  // Preview UI origin once the tool reports it, e.g. `http://localhost:3200`.
  url: optional(Schema.String),
  pid: optional(NonNegativeInt),
  exitCode: optional(Schema.Int),
  // Most recent lines of combined stdout/stderr with ANSI escapes removed.
  log: Schema.Array(Schema.String),
}).annotate({ identifier: "DevicePreview.Server" })

export const BuildStatus = Schema.Literals(["idle", "building", "installing", "launching", "running", "failed"])
export type BuildStatus = typeof BuildStatus.Type

export interface Build extends Schema.Schema.Type<typeof Build> {}
export const Build = Schema.Struct({
  platform: Platform,
  status: BuildStatus,
  // Native project directory this build targets, which may be below the session directory.
  directory: optional(Schema.String),
  // Xcode scheme or Gradle module.
  target: optional(Schema.String),
  // Bundle identifier or Android package name.
  appID: optional(Schema.String),
  // Short description of the current step, shown next to the run control.
  step: optional(Schema.String),
  error: optional(Schema.String),
  log: Schema.Array(Schema.String),
  startedAt: optional(NonNegativeInt),
  finishedAt: optional(NonNegativeInt),
}).annotate({ identifier: "DevicePreview.Build" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  // Platforms detected from the project files at or below the requested location.
  platforms: Schema.Array(Platform),
  // Preview servers managed by this opencode process, regardless of location.
  servers: Schema.Array(Server),
  // Build and run state for the requested location.
  builds: Schema.Array(Build),
}).annotate({ identifier: "DevicePreview.Info" })

export interface PlatformInput extends Schema.Schema.Type<typeof PlatformInput> {}
export const PlatformInput = Schema.Struct({
  platform: Platform,
}).annotate({ identifier: "DevicePreview.PlatformInput" })
