import path from "path"
import { describe, expect, test } from "bun:test"
import { DeviceBuild } from "@opencode-ai/core/device-build"
import { tmpdir } from "./fixture/tmpdir"

const darwin = process.platform === "darwin"

async function write(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content)
}

const expoConfig = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ expo: { name: "My App", slug: "my-app", ...extra } }, null, 2) + "\n"

describe("DeviceBuild.findProjects", () => {
  test("expo app without native folders needs prebuild on every platform", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, {
      "app.json": expoConfig(),
      "package.json": JSON.stringify({ dependencies: { expo: "^52.0.0", "react-native": "0.76.0" } }),
    })

    const projects = DeviceBuild.findProjects(tmp.path)
    const android = projects.find((project) => project.platform === "android")

    expect(android).toEqual({
      platform: "android",
      directory: tmp.path,
      root: tmp.path,
      framework: "expo",
      needsPrebuild: true,
    })
    if (darwin) expect(projects.find((project) => project.platform === "ios")?.needsPrebuild).toBe(true)
  })

  test("prebuilt expo app builds from the generated folders and keeps the JS root", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, {
      "app.json": expoConfig(),
      "package.json": JSON.stringify({ dependencies: { expo: "^52.0.0" } }),
      "android/settings.gradle": "include ':app'\n",
      "ios/MyApp.xcworkspace/contents.xcworkspacedata": "",
    })

    const projects = DeviceBuild.findProjects(tmp.path)
    const android = projects.find((project) => project.platform === "android")

    expect(android).toEqual({
      platform: "android",
      directory: path.join(tmp.path, "android"),
      root: tmp.path,
      framework: "expo",
      needsPrebuild: false,
    })
    if (darwin) {
      const ios = projects.find((project) => project.platform === "ios")
      expect(ios?.directory).toBe(path.join(tmp.path, "ios"))
      expect(ios?.framework).toBe("expo")
      expect(ios?.needsPrebuild).toBe(false)
    }
  })

  test("bare react native app is detected from package.json", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, {
      "package.json": JSON.stringify({ dependencies: { react: "18.0.0", "react-native": "0.76.0" } }),
      "android/settings.gradle": "include ':app'\n",
    })

    const android = DeviceBuild.findProjects(tmp.path).find((project) => project.platform === "android")

    expect(android?.framework).toBe("react-native")
    expect(android?.root).toBe(tmp.path)
    expect(android?.directory).toBe(path.join(tmp.path, "android"))
  })

  test("plain native project has no JS root of its own", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, { "settings.gradle.kts": "", gradlew: "" })

    const android = DeviceBuild.findProjects(tmp.path).find((project) => project.platform === "android")

    expect(android).toEqual({
      platform: "android",
      directory: tmp.path,
      root: tmp.path,
      framework: "native",
      needsPrebuild: false,
    })
  })

  test("a JS package that is not a mobile app is ignored", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, { "package.json": JSON.stringify({ dependencies: { react: "18.0.0" } }) })

    expect(DeviceBuild.findProjects(tmp.path)).toEqual([])
  })

  test("nested app is found from the session directory", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, {
      "apps/mobile/app.json": expoConfig(),
      "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "^52.0.0" } }),
    })

    const android = DeviceBuild.findProjects(tmp.path).find((project) => project.platform === "android")

    expect(android?.root).toBe(path.join(tmp.path, "apps", "mobile"))
    expect(android?.needsPrebuild).toBe(true)
  })
})

describe("DeviceBuild.ensureExpoAppIds", () => {
  test("fills in a package name derived from the slug", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, { "app.json": expoConfig() })

    const note = DeviceBuild.ensureExpoAppIds(tmp.path, "android")
    const saved = JSON.parse(await Bun.file(path.join(tmp.path, "app.json")).text())

    expect(note).toBe("Set expo.android.package to com.anonymous.myapp in app.json")
    expect(saved.expo.android.package).toBe("com.anonymous.myapp")
    expect(saved.expo.ios).toBeUndefined()
  })

  test("leaves an existing identifier alone", async () => {
    await using tmp = await tmpdir()
    const text = expoConfig({ ios: { bundleIdentifier: "com.acme.app" } })
    await write(tmp.path, { "app.json": text })

    const note = DeviceBuild.ensureExpoAppIds(tmp.path, "ios")

    expect(note).toBeUndefined()
    expect(await Bun.file(path.join(tmp.path, "app.json")).text()).toBe(text)
  })

  test("keeps the file's indentation", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, { "app.json": JSON.stringify({ expo: { slug: "demo" } }, null, 4) + "\n" })

    DeviceBuild.ensureExpoAppIds(tmp.path, "ios")

    expect(await Bun.file(path.join(tmp.path, "app.json")).text()).toBe(
      JSON.stringify({ expo: { slug: "demo", ios: { bundleIdentifier: "com.anonymous.demo" } } }, null, 4) + "\n",
    )
  })

  test("does nothing without an app.json", async () => {
    await using tmp = await tmpdir()
    expect(DeviceBuild.ensureExpoAppIds(tmp.path, "ios")).toBeUndefined()
  })
})

describe("DeviceBuild.preflight", () => {
  test("asks for an install before building an expo app with no node_modules", async () => {
    await using tmp = await tmpdir()
    const project: DeviceBuild.Project = {
      platform: "android",
      directory: tmp.path,
      root: tmp.path,
      framework: "expo",
      needsPrebuild: true,
    }

    expect(DeviceBuild.preflight(project)).toBe(
      `Dependencies are not installed. Run \`npm install\` in ${tmp.path} and try again.`,
    )
  })
})

describe("DeviceBuild helpers", () => {
  test("bundler command per framework", () => {
    expect(DeviceBuild.bundlerCommand("expo", 8081)).toEqual({
      command: "npx",
      args: ["expo", "start", "--dev-client", "--port", "8081"],
    })
    expect(DeviceBuild.bundlerCommand("react-native", 8082)).toEqual({
      command: "npx",
      args: ["react-native", "start", "--port", "8082"],
    })
  })

  test("prebuilt directory only counts once the native project exists", async () => {
    await using tmp = await tmpdir()
    expect(DeviceBuild.prebuiltDirectory(tmp.path, "android")).toBeUndefined()
    await write(tmp.path, { "android/build.gradle": "" })
    expect(DeviceBuild.prebuiltDirectory(tmp.path, "android")).toBe(path.join(tmp.path, "android"))
  })

  test("pods are installed when there is no Podfile or a manifest exists", async () => {
    await using tmp = await tmpdir()
    expect(DeviceBuild.podsInstalled(tmp.path)).toBe(true)
    await write(tmp.path, { Podfile: "" })
    expect(DeviceBuild.podsInstalled(tmp.path)).toBe(false)
    await write(tmp.path, { "Pods/Manifest.lock": "" })
    expect(DeviceBuild.podsInstalled(tmp.path)).toBe(true)
  })
})

describe("DeviceBuild.freePort", () => {
  test("skips a port something is listening on", async () => {
    const { createServer } = await import("net")
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen({ port: 0, host: "127.0.0.1" }, resolve))
    const taken = (holder.address() as { port: number }).port
    try {
      expect(await DeviceBuild.freePort(taken, 3)).toBe(taken + 1)
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })

  test("gives up when the whole range is busy", async () => {
    const { createServer } = await import("net")
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen({ port: 0, host: "127.0.0.1" }, resolve))
    const taken = (holder.address() as { port: number }).port
    try {
      expect(await DeviceBuild.freePort(taken, 1)).toBeUndefined()
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })
})

describe("DeviceBuild android helpers", () => {
  test("reads free space from df output", () => {
    const output =
      "Filesystem       1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-53   6082144 5529020    553124  91% /data\n"
    expect(DeviceBuild.parseFreeMb(output)).toBe(540)
    expect(DeviceBuild.parseFreeMb("")).toBeUndefined()
    expect(DeviceBuild.parseFreeMb("df: /data: No such file or directory")).toBeUndefined()
  })

  test("extracts the adb install failure reason", () => {
    const log = [
      "Performing Streamed Install",
      "adb: failed to install app-debug.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to override installation location]",
    ]
    expect(DeviceBuild.installFailure(log)).toBe(
      "INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to override installation location",
    )
    expect(DeviceBuild.installFailure(["Success"])).toBeUndefined()
  })

  test("limits React Native builds to one ABI when known", () => {
    expect(DeviceBuild.reactNativeArchitectureArgs("arm64-v8a")).toEqual(["-PreactNativeArchitectures=arm64-v8a"])
    expect(DeviceBuild.reactNativeArchitectureArgs(undefined)).toEqual([])
  })
})

describe("DeviceBuild.parseLsofCwd", () => {
  test("reads the working directory field", () => {
    expect(DeviceBuild.parseLsofCwd("p43297\nfcwd\nn/Users/me/app\n")).toBe("/Users/me/app")
    expect(DeviceBuild.parseLsofCwd("")).toBeUndefined()
  })
})

describe("DeviceBuild node requirement", () => {
  const rn = "^20.19.4 || ^22.13.0 || ^24.3.0 || >= 25.0.0"
  test("matches react-native's compound range", () => {
    expect(DeviceBuild.satisfies([18, 17, 0], rn)).toBe(false)
    expect(DeviceBuild.satisfies([20, 15, 1], rn)).toBe(false)
    expect(DeviceBuild.satisfies([20, 19, 5], rn)).toBe(true)
    expect(DeviceBuild.satisfies([21, 0, 0], rn)).toBe(false)
    expect(DeviceBuild.satisfies([22, 13, 0], rn)).toBe(true)
    expect(DeviceBuild.satisfies([24, 15, 0], rn)).toBe(true)
    expect(DeviceBuild.satisfies([26, 0, 0], rn)).toBe(true)
  })

  test("handles the common single-range forms", () => {
    expect(DeviceBuild.satisfies([20, 19, 4], ">=20.19.4")).toBe(true)
    expect(DeviceBuild.satisfies([20, 19, 3], ">=20.19.4")).toBe(false)
    expect(DeviceBuild.satisfies([20, 5, 0], "20")).toBe(true)
    expect(DeviceBuild.satisfies([21, 0, 0], "20")).toBe(false)
    expect(DeviceBuild.satisfies([20, 5, 0], "20.x")).toBe(true)
    expect(DeviceBuild.satisfies([20, 5, 0], ">=18 <21")).toBe(true)
    expect(DeviceBuild.satisfies([21, 0, 0], ">=18 <21")).toBe(false)
    expect(DeviceBuild.satisfies([21, 0, 0], ">20")).toBe(true)
    expect(DeviceBuild.satisfies([20, 9, 0], ">20")).toBe(false)
    expect(DeviceBuild.satisfies([20, 3, 9], "~20.3.0")).toBe(true)
    expect(DeviceBuild.satisfies([20, 4, 0], "~20.3.0")).toBe(false)
    expect(DeviceBuild.satisfies([1, 2, 3], "garbage")).toBe(true)
  })

  test("collects every declared range from the project and its toolchain", async () => {
    await using tmp = await tmpdir()
    await write(tmp.path, {
      "package.json": JSON.stringify({ engines: { node: ">=18" } }),
      "node_modules/react-native/package.json": JSON.stringify({ engines: { node: "^20.19.4 || ^22.13.0" } }),
      "node_modules/expo/package.json": JSON.stringify({ version: "57.0.0" }),
    })
    expect(DeviceBuild.nodeRequirement(tmp.path)).toEqual([">=18", "^20.19.4 || ^22.13.0"])
  })

  test("parses versions out of command output and directory names", () => {
    expect(DeviceBuild.parseVersion("v20.19.5\n")).toEqual([20, 19, 5])
    expect(DeviceBuild.parseVersion("node-v22.1.0")).toEqual([22, 1, 0])
    expect(DeviceBuild.parseVersion("latest")).toBeUndefined()
  })
})
