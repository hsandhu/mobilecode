import { expect, test } from "@playwright/test"
import type { DevicePreview } from "@opencode-ai/schema/device-preview"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/DeviceControls"
const sessionID = "ses_device_controls"
const labels = { ios: "iOS Simulator", android: "Android Emulator" }

for (const platforms of [["ios", "android"], ["ios"], ["android"]] as const) {
  test(`device controls: ${platforms.join(" and ")}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    const expo = platforms.length === 2
    const state: { info: DevicePreview.Info } = {
      info: { platforms, framework: expo ? "expo" : "native", servers: [], builds: [] },
    }
    const calls: { path: string; directory: string | null; platform?: string }[] = []
    let releaseStop = () => {}
    const stopResponse = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_devices",
        worktree: directory,
        vcs: "git",
        name: "Devices",
        time: { created: 1700000000000, updated: 1700000000000 },
        sandboxes: [],
      },
      provider: { all: [], connected: [], default: {} },
      sessions: [
        {
          id: sessionID,
          slug: "devices",
          projectID: "proj_devices",
          directory,
          title: "Device controls",
          version: "dev",
          time: { created: 1700000000000, updated: 1700000000000 },
        },
      ],
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/api/device-preview**", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === "POST") {
        const platform = request.postDataJSON()?.platform as DevicePreview.Platform | undefined
        calls.push({ path: url.pathname, directory: url.searchParams.get("location[directory]"), platform })
        if (url.pathname === "/api/device-preview/bundler/start")
          state.info = {
            ...state.info,
            bundler: {
              framework: "expo",
              directory,
              status: "running",
              command: "npx expo start",
              url: "http://localhost:8081",
              log: ["Metro fixture ready"],
            },
          }
        if (platform && url.pathname === "/api/device-preview/run")
          state.info = {
            ...state.info,
            builds: [
              ...state.info.builds.filter((build) => build.platform !== platform),
              {
                platform,
                status: expo && platform === "ios" ? "failed" : "running",
                device: `${platform}-fixture`,
                appID: "com.test.app",
                log: [`${platform} build fixture ready`],
              },
            ],
          }
        if (platform && url.pathname === "/api/device-preview/run/stop") {
          await stopResponse
          state.info = {
            ...state.info,
            builds: state.info.builds.map((build) =>
              build.platform === platform ? { ...build, status: "idle", device: undefined } : build,
            ),
          }
        }
      }
      await route.fulfill({ json: { data: state.info } })
    })
    await page.addInitScript(() =>
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } })),
    )
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const controls = page.locator('[data-component="device-run"]')
    for (const platform of platforms) {
      await expect(
        controls.getByRole("button", {
          name: `Build and run on ${labels[platform]}`,
          exact: true,
        }),
      ).toBeEnabled()
    }
    expect(calls).toEqual([])

    if (expo) {
      await controls.getByRole("button", { name: "Start", exact: true }).click()
      await expect(controls.getByRole("button", { name: "Stop", exact: true })).toBeEnabled()
      expect(calls).toEqual([{ path: "/api/device-preview/bundler/start", directory }])
      await page.getByRole("button", { name: "Log", exact: true }).click()
      await expect(page.getByText("Metro fixture ready", { exact: true })).toBeVisible()
    }

    for (const platform of platforms) {
      const label = labels[platform]
      await controls.getByRole("button", { name: `Build and run on ${label}`, exact: true }).click()
      await expect(controls.getByRole("button", { name: `Stop running on ${label}`, exact: true })).toBeEnabled()
      if (expo && platform === "ios")
        await expect(
          controls.getByRole("button", { name: "Build and run on Android Emulator", exact: true }),
        ).toBeEnabled()
    }

    for (const platform of platforms) {
      const label = labels[platform]
      const pane = page.getByRole("toolbar", { name: label, exact: true })
      await pane.getByRole("button", { name: "Log", exact: true }).click()
      await expect(page.getByText(`${platform} build fixture ready`, { exact: true })).toBeVisible()
      await pane.getByRole("button", { name: "Stop", exact: true }).click()
      if (platform === platforms[0]) {
        await expect(pane.getByRole("button", { name: "Stop", exact: true })).toBeDisabled()
        await expect(controls.getByRole("button", { name: `Stop running on ${label}`, exact: true })).toBeDisabled()
        releaseStop()
      }
      await expect(controls.getByRole("button", { name: `Build and run on ${label}`, exact: true })).toBeEnabled()
      if (expo && platform === "ios")
        await expect(
          controls.getByRole("button", { name: "Stop running on Android Emulator", exact: true }),
        ).toBeEnabled()
    }
    if (expo) await expect(controls.getByRole("button", { name: "Stop", exact: true })).toBeEnabled()
    expect(calls).toEqual([
      ...(expo ? [{ path: "/api/device-preview/bundler/start", directory }] : []),
      ...platforms.map((platform) => ({ path: "/api/device-preview/run", directory, platform })),
      ...platforms.map((platform) => ({ path: "/api/device-preview/run/stop", directory, platform })),
    ])
  })
}
