export * from "./types.ts"
export * from "./errors.ts"
export * from "./client.ts"
export * from "./http.ts"
export * from "./open.ts"
export * from "./provider.ts"
export * from "./media.ts"
export { PixelLabProvider } from "./providers/pixellab.ts"
export { RetroDiffusionProvider, type RetroDiffusionOptions } from "./providers/retrodiffusion.ts"
export { ScenarioProvider, type ScenarioOptions } from "./providers/scenario.ts"
export {
  ComfyUIProvider,
  type ComfyUIBinding,
  type ComfyUIBindings,
  type ComfyUIFramesOptions,
  type ComfyUIImageInput,
  type ComfyUIOptions,
} from "./providers/comfyui.ts"
export { FakeProvider, FAKE_PNG, type FakeOptions } from "./providers/fake.ts"
export {
  registerProvider,
  providerFactory,
  providerCredentialEnvs,
  createProvider,
  availableProviders,
  type ProviderFactory,
  type ProviderMode,
} from "./providers/registry.ts"
export * from "./manifest.ts"
export { openProject, type OpenProjectOptions, type Project } from "./project.ts"
export * from "./lock.ts"
export * from "./hash.ts"
export * from "./source-url.ts"
export * from "./outputs.ts"
export * from "./artifacts.ts"
export * from "./recipes.ts"
export {
  buildPlan,
  resumeActions,
  resumeCommandForStatus,
  summarize,
  type Plan,
  type PlanItem,
  type PlanState,
  type ResumeAction,
  type ResumeCommand,
} from "./pipeline/plan.ts"
export * from "./pipeline/audit.ts"
export * from "./pipeline/refine.ts"
export * from "./pixellab-utils.ts"
export * from "./pipeline/quality-profile.ts"
export * from "./pipeline/revision.ts"
export * from "./pipeline/quality-regression.ts"
export * from "./pipeline/cache-health.ts"
export * from "./pipeline/pack.ts"
export * from "./pipeline/tileset-export.ts"
export * from "./pipeline/sheet-formats.ts"
export { submit, type SubmitOptions, type SubmitResult } from "./pipeline/submit.ts"
export { poll, type PollOptions, type PollResult } from "./pipeline/poll.ts"
export { fetchAssets, pushTags, type FetchResult } from "./pipeline/fetch.ts"
export { doctor, type DoctorCheck, type DoctorLevel, type DoctorOptions, type DoctorReport } from "./pipeline/doctor.ts"
export { adopt, tagAdopted, type AdoptResult } from "./pipeline/adopt.ts"
export {
  prepareReview,
  runPicker,
  type PickResult,
  type PrepareReviewOptions,
  type ReviewReadyInfo,
  type ReviewSession,
} from "./pick/server.ts"
export { renderSheet, type RenderSheetOptions, type SheetGroup } from "./pick/sheet.ts"
export {
  buildGallerySnapshot,
  buildWorkspaceGallerySnapshot,
  galleryMediaId,
  galleryMediaRoute,
  type BuildGalleryOptions,
  type BuildWorkspaceGalleryOptions,
  type GalleryBuild,
  type GalleryEditMeta,
  type GalleryGeneration,
  type GalleryItem,
  type GalleryMedia,
  type GalleryOutput,
  type GalleryProject,
  type GalleryQuality,
  type GallerySnapshot,
  type GalleryState,
  type GalleryStyle,
  type HandEditStatus,
} from "./gallery/snapshot.ts"
export { galleryContentSecurityPolicy, renderGallery, type RenderGalleryOptions } from "./gallery/page.ts"
export {
  detachHandEdit,
  HAND_EDIT_DIR,
  handEditBase,
  handEditBases,
  handEditCompanionPath,
  HandEditCompanionSchema,
  handEditMembers,
  handEditPath,
  handEditProjectPath,
  MAX_HAND_EDIT_BYTES,
  openInEditor,
  readHandEditCompanion,
  saveHandEdit,
  startHandEdit,
  type HandEditCompanion,
  type HandEditMember,
  type HandEditSave,
  type HandEditSaveInput,
  type HandEditStart,
} from "./pipeline/hand-edit.ts"
export {
  historyAfterReplacing,
  historyLimit,
  HISTORY_ENV,
  pickHistory,
  referencedHashes,
  retireGeneration,
  revertGeneration,
  type HistoryPick,
  type RevertOptions,
  type RevertResult,
} from "./pipeline/history.ts"
export {
  EDITOR_PIN,
  EDITOR_RELEASE_BASE,
  type EditorPin,
} from "./editor/pin.ts"
export {
  editorBaseUrl,
  editorDir,
  EditorInstallError,
  editorStatus,
  editorToolsRoot,
  installEditor,
  type EditorInstallOptions,
  type EditorInstallProgress,
  type EditorInstallResult,
  type EditorInstallStatus,
} from "./editor/install.ts"
export {
  createGalleryEditorHandlers,
  editorRoute,
  type GalleryEditorHandlers,
  type GalleryEditorOptions,
  type GalleryEditorStatus,
} from "./gallery/editor.ts"
export {
  applyManifestEdit,
  createGalleryEditHandler,
  ManifestDriftError,
  ManifestEditError,
  ManifestEditSchema,
  type GalleryEditHandlerOptions,
  type ManifestEdit,
  type ManifestEditResult,
} from "./gallery/edit.ts"
export { serveGallery, type GalleryServer, type GalleryServerOptions } from "./gallery/server.ts"
export {
  createGenerateHandlers,
  GenerateRequestError,
  GenerateRequestSchema,
  type GalleryGenerateHandlers,
  type GalleryProjectContext,
  type GenerateHandlerOptions,
  type GenerateJob,
  type GeneratePhase,
  type GenerateStatus,
  type SessionBudget,
} from "./gallery/generate.ts"
export { scanAssets, buildManifest, pngSize, slugify, type ScannedAsset } from "./pipeline/init.ts"
export {
  loadClaims,
  findOrphans,
  matchOrphanStyle,
  groupOrphansByStyle,
  loadSiblingManifests,
  idFromPrompt,
  applyTags,
  type Orphan,
  type OrphanGroups,
  type SiblingManifest,
  type SalvageAction,
} from "./pipeline/salvage.ts"
export { runSalvage, type SalvageResult } from "./pick/salvage-server.ts"
export { renderSalvageSheet } from "./pick/salvage-sheet.ts"
export {
  WorkspaceProjectSchema,
  WorkspaceSchema,
  parseWorkspace,
  loadWorkspace,
  saveWorkspace,
  toPortablePath,
  resolveProject,
  validateWorkspace,
  type Workspace,
  type WorkspaceProject,
  type WorkspaceDiagnostic,
} from "./workspace.ts"
export {
  workspaceClaims,
  workspaceStatus,
  type WorkspaceClaims,
  type WorkspaceProjectStatus,
  type WorkspaceStatusReport,
} from "./pipeline/workspace.ts"
