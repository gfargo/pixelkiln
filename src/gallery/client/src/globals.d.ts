/** Written by the server into the page ahead of the bundle; see page.ts. */
declare const INITIAL: import("../../snapshot.ts").GallerySnapshot
/** The session token every write sends back, or null when the page is read-only. */
declare const SESSION: string | null
/** Manifest editing is on (`--edit`). */
declare const EDITABLE: boolean
/** Generation jobs are on (`--budget`). */
declare const GENERATION: boolean
/** The in-browser editor can be installed and served. */
declare const EDITOR: boolean
