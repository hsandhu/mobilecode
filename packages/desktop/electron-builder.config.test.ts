import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "dev.mobilecode.desktop.dev", productName: "MobileCode Dev", protocolName: "MobileCode" },
  {
    channel: "beta",
    appId: "dev.mobilecode.desktop.beta",
    productName: "MobileCode Beta",
    protocolName: "MobileCode Beta",
  },
  { channel: "prod", appId: "dev.mobilecode.desktop", productName: "MobileCode", protocolName: "MobileCode" },
] as const

test("tracks the OpenCode version", async () => {
  const desktop = await Bun.file("package.json").json()
  const opencode = await Bun.file("../opencode/package.json").json()
  expect(desktop.version).toBe(opencode.version)
})

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(channel.productName)
    expect(config.artifactName).toBe("mobilecode-desktop-${os}-${arch}.${ext}")
    expect(config.extraMetadata?.name).toBe("mobilecode-desktop")
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.protocols).toEqual({
      name: channel.protocolName,
      schemes: ["mobilecode"],
    })
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("publishes production updates only from the MobileCode repository", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?publish=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.publish).toEqual({ provider: "github", owner: "hsandhu", repo: "mobilecode", channel: "latest" })
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/mobilecode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["mobilecode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["mobilecode-cli*"],
    })
  })
}

test("supports unsigned macOS packages", async () => {
  const previous = process.env.CSC_IDENTITY_AUTO_DISCOVERY
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false"

  const module = await import("./electron-builder.config.ts?unsigned=macos")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY
  else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previous

  expect(config.mac?.notarize).toBe(false)
  expect(config.dmg?.sign).toBe(false)
})
