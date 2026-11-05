import { describe, expect, test } from "bun:test"
import { deviceMetroPath, devicePreviewUrl } from "./preview"

describe("devicePreviewUrl", () => {
  test("keeps a loopback preview of a local server", () => {
    expect(devicePreviewUrl("http://localhost:3200/", "http://127.0.0.1:4096")).toBe("http://localhost:3200/")
  })

  test("points a loopback preview of a remote server at that server's host", () => {
    expect(devicePreviewUrl("http://127.0.0.1:3200/stream", "https://mac.lan:4096")).toBe("http://mac.lan:3200/stream")
  })

  test("leaves an address that is not loopback, and anything it cannot parse", () => {
    expect(devicePreviewUrl("http://10.0.0.2:3200/", "https://mac.lan:4096")).toBe("http://10.0.0.2:3200/")
    expect(devicePreviewUrl("not a url", "https://mac.lan:4096")).toBe("not a url")
    expect(devicePreviewUrl(undefined, "https://mac.lan:4096")).toBeUndefined()
  })
})

describe("deviceMetroPath", () => {
  test("names the session's folder, and the path below it", () => {
    expect(deviceMetroPath("/work/app", "/work/app/")).toBe("app")
    expect(deviceMetroPath("/work/app/apps/mobile", "/work/app")).toBe("app/apps/mobile")
    expect(deviceMetroPath("C:\\Work\\App\\mobile", "c:/work/app")).toBe("app/mobile")
  })

  test("shows a folder outside the session in full", () => {
    expect(deviceMetroPath("/work/other", "/work/app")).toBe("/work/other")
  })
})
