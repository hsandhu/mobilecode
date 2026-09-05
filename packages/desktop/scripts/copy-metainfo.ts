import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "dev.mobilecode.desktop" : `dev.mobilecode.desktop.${channel}`
const productName =
  channel === "prod" ? "MobileCode" : `MobileCode ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Open source AI coding agent for mobile apps${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="com.github.hsandhu">
    <name>MobileCode contributors</name>
  </developer>

  <description>
    <p>
      MobileCode is an open source agent that helps you write and run mobile apps with any AI model, with iOS Simulator and Android Emulator previews built in.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/hsandhu/mobilecode/issues</url>
  <url type="homepage">https://github.com/hsandhu/mobilecode</url>
  <url type="vcs-browser">https://github.com/hsandhu/mobilecode</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
