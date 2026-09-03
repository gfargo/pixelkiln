import type { Provider } from "../provider.ts"
import { ComfyUIProvider } from "./comfyui.ts"
import { PixelLabProvider } from "./pixellab.ts"
import { RetroDiffusionProvider } from "./retrodiffusion.ts"

export type ProviderMode = "online" | "offline" | "downloads"

/** Construction metadata kept outside adapters so the CLI stays generic. */
export interface ProviderFactory {
  readonly id: string
  /** Environment variable expected for authenticated operations, if any. */
  readonly credentialEnv?: string
  create(mode: ProviderMode): Provider
}

const factories = new Map<string, ProviderFactory>()

/** Register a provider without allowing import order to replace an existing id. */
export function registerProvider(factory: ProviderFactory): void {
  const id = factory.id.trim()
  if (!id) throw new Error("Provider id cannot be empty")
  if (factories.has(id)) throw new Error(`Provider "${id}" is already registered`)
  factories.set(id, factory)
}

export function providerFactory(id: string): ProviderFactory {
  const factory = factories.get(id)
  if (!factory) {
    const available = [...factories.keys()].sort().join(", ") || "(none)"
    throw new Error(`Unknown provider "${id}". Available providers: ${available}`)
  }
  return factory
}

export function createProvider(id: string, mode: ProviderMode): Provider {
  return providerFactory(id).create(mode)
}

export function availableProviders(): string[] {
  return [...factories.keys()].sort()
}

registerProvider({
  id: "pixellab",
  credentialEnv: "PIXELLAB_API_KEY",
  create(mode) {
    if (mode === "online") return PixelLabProvider.fromEnv()
    if (mode === "downloads") return PixelLabProvider.forDownloads()
    return PixelLabProvider.forOffline()
  },
})

registerProvider({
  id: "retrodiffusion",
  credentialEnv: "RD_API_KEY",
  create(mode) {
    if (mode === "online") return RetroDiffusionProvider.fromEnv()
    if (mode === "downloads") return RetroDiffusionProvider.forDownloads()
    return RetroDiffusionProvider.forOffline()
  },
})

registerProvider({
  id: "comfyui",
  create(mode) {
    if (mode === "online") return ComfyUIProvider.fromEnv()
    if (mode === "downloads") return ComfyUIProvider.forDownloads()
    return ComfyUIProvider.forOffline()
  },
})
