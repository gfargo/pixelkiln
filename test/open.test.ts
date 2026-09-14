import { describe, expect, it, vi } from "vitest"

const spawn = vi.hoisted(() => vi.fn(() => {
  const child = { on: vi.fn(), unref: vi.fn() }
  return child
}))
vi.mock("node:child_process", () => ({ spawn }))

import { defaultOpenCommand, openExternal } from "../src/open.ts"

describe("openExternal", () => {
  it("picks the platform's default handler", () => {
    expect(defaultOpenCommand("darwin")).toEqual(["open"])
    expect(defaultOpenCommand("linux")).toEqual(["xdg-open"])
    expect(defaultOpenCommand("freebsd")).toEqual(["xdg-open"])
    expect(defaultOpenCommand("win32")).toEqual(["cmd", "/c", "start", ""])
  })

  it("launches detached and never throws when the handler is missing", () => {
    spawn.mockClear()
    const used = openExternal("http://127.0.0.1:4800/", defaultOpenCommand("linux"))
    expect(used).toBe("xdg-open")
    expect(spawn).toHaveBeenCalledWith("xdg-open", ["http://127.0.0.1:4800/"], { stdio: "ignore", detached: true })
    const child = spawn.mock.results[0]!.value as { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
    expect(child.unref).toHaveBeenCalled()
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function))
  })

  it("keeps a URL with spaces intact behind Windows' empty window title", () => {
    spawn.mockClear()
    openExternal("C:\\art\\hero sprite.png", defaultOpenCommand("win32"))
    expect(spawn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "C:\\art\\hero sprite.png"], expect.anything())
  })
})
