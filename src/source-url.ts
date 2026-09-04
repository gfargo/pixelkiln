const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "awsaccesskeyid",
  "googleaccessid",
  "key",
  "sig",
])

/** True when a URL contains credentials or a temporary signing secret. */
export function isSensitiveSourceUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return true
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase()
    if (
      SENSITIVE_QUERY_KEYS.has(normalized) ||
      normalized.includes("credential") ||
      normalized.includes("signature") ||
      normalized.includes("security-token") ||
      normalized.includes("token")
    ) return true
  }
  return false
}

/**
 * Whether a provider source is safe and useful to retain after its bytes have
 * reached the destination. Inline and machine-local sources are transient;
 * credential-bearing URLs must not settle into a committable lockfile.
 */
export function shouldPersistSourceUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // Preserve unknown legacy/provider references. They remain subject to
    // provider download validation and contain no parseable URL credentials.
    return true
  }
  if (parsed.protocol === "data:" || parsed.protocol === "file:") return false
  return !isSensitiveSourceUrl(value)
}
