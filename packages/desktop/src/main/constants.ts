import { app } from "electron"
import { DESKTOP_APP_IDS, DESKTOP_APP_NAMES } from "../../product"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged && CHANNEL !== "local" ? DESKTOP_APP_NAMES[CHANNEL] : DESKTOP_APP_NAMES.dev

export const APP_ID = app.isPackaged && CHANNEL !== "local" ? DESKTOP_APP_IDS[CHANNEL] : DESKTOP_APP_IDS.dev
