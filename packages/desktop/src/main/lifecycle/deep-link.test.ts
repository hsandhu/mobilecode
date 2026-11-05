import { describe, expect, test } from "bun:test"
import { consoleReturnWindow } from "./deep-link"

describe("Console return deep links", () => {
  test("reads the originating Desktop window", () => {
    expect(consoleReturnWindow("mobilecode://console/authorized?window=window-a")).toBe("window-a")
    expect(consoleReturnWindow("mobilecode://console/authorized?window=window%20b")).toBe("window b")
  })

  test("rejects unrelated and malformed links", () => {
    expect(consoleReturnWindow("mobilecode://console/other?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("mobilecode://other/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("https://console/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("not a url")).toBeUndefined()
    expect(consoleReturnWindow("mobilecode://console/authorized")).toBeUndefined()
  })
})
