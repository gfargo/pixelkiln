import { describe, expect, it } from "vitest"
import { isSensitiveSourceUrl, shouldPersistSourceUrl } from "../src/source-url.ts"

describe("source URL hygiene", () => {
  it("recognizes common credential-bearing URL shapes", () => {
    const signed = new URL("https://cdn.example.test/output.png")
    signed.searchParams.set("X-Amz-Credential", "temporary")
    signed.searchParams.set("X-Amz-Signature", "secret")
    expect(isSensitiveSourceUrl(signed.href)).toBe(true)

    const bearer = new URL("https://cdn.example.test/output.png")
    bearer.searchParams.set("access_token", "secret")
    expect(isSensitiveSourceUrl(bearer.href)).toBe(true)
    expect(isSensitiveSourceUrl("https://user:password@cdn.example.test/output.png")).toBe(true)
  })

  it("retains durable public and provider-local references", () => {
    expect(shouldPersistSourceUrl("https://cdn.example.test/output.png?v=2")).toBe(true)
    expect(shouldPersistSourceUrl("comfyui://output?filename=one.png&type=output")).toBe(true)
    expect(shouldPersistSourceUrl("fake://object.png")).toBe(true)
  })

  it("drops signed, inline, and machine-local references after ingestion", () => {
    const signed = new URL("https://cdn.example.test/output.png")
    signed.searchParams.set("sig", "secret")
    expect(shouldPersistSourceUrl(signed.href)).toBe(false)
    expect(shouldPersistSourceUrl("data:image/png;base64,AAAA")).toBe(false)
    expect(shouldPersistSourceUrl("file:///tmp/provider-output.png")).toBe(false)
  })
})
