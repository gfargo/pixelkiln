extends Node
## PixelKiln host bridge.
##
## The gallery embeds Pixelorama in an iframe and talks to it over
## `postMessage`; this node is the Pixelorama side of that conversation. It
## is an internal extension of the PixelKiln build (see `_add_internal_extensions`
## in HandleExtensions.gd) and does nothing outside a web export.
##
## Protocol (all messages carry `type: "pixelkiln:<name>"`; same origin only):
##   host → editor   open          { request, asset: {key, id, name, width, height}, png: ArrayBuffer, pxo?: ArrayBuffer,
##                                   frames?: [{role, png: ArrayBuffer}], fps?, palette: [#rrggbb] }
##   host → editor   request-save  { request }
##   editor → host   ready         { version, editor }
##   editor → host   opened        { request, width, height, source: "pxo" | "png" | "frames", layers, frames }
##   editor → host   dirty         { dirty }
##   editor → host   save          { request, width, height, png: ArrayBuffer, frames: [{role, png}], pxo: ArrayBuffer }
##   editor → host   error         { request?, message }
##
## `open` with a `pxo` restores the layered project a previous `save` returned;
## the `png` (or `frames`) is the fallback when the project file cannot be
## read. `opened` says which one the editor used. An ordered frame set opens
## as one project with a frame per member; `save` returns every frame
## flattened, each tagged with the role it was opened under (null for a frame
## added in the editor), and `png` stays the first frame for older hosts.
##
## Bytes cross the JavaScript boundary as base64 inside a small shim this
## node installs on `window.__pixelkiln`; the shim converts to and from
## ArrayBuffers so the page-facing protocol stays binary.

const PROTOCOL_VERSION := 3
const PXO_TMP := "user://pixelkiln-edit.pxo"
## Projects handed over by the host are written here to be opened; the file
## name becomes the project name, so one file per asset name.
const PXO_OPEN_DIR := "user://pixelkiln-open"
const MENU_LABEL := "Save to PixelKiln"

## Installed once via JavaScriptBridge.eval. Keeps an inbox the node drains
## every frame, and posts replies to the parent window on the same origin.
const SHIM := """
(() => {
  if (window.__pixelkiln) return;
  const toB64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  const box = { queue: [], take() { const q = this.queue; this.queue = []; return JSON.stringify(q); },
    post(json) { const m = JSON.parse(json); const transfer = []; for (const k of ["png", "pxo"]) { if (typeof m[k] === "string") { m[k] = fromB64(m[k]); transfer.push(m[k]); } }
      if (Array.isArray(m.frames)) for (const f of m.frames) { if (typeof f.png === "string") { f.png = fromB64(f.png); transfer.push(f.png); } }
      if (window.parent && window.parent !== window) window.parent.postMessage(m, window.location.origin, transfer); } };
  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin || !e.data || typeof e.data.type !== "string" || !e.data.type.startsWith("pixelkiln:")) return;
    const m = Object.assign({}, e.data);
    for (const k of ["png", "pxo"]) { if (m[k] instanceof ArrayBuffer || ArrayBuffer.isView(m[k])) m[k] = toB64(m[k].buffer || m[k]); }
    if (Array.isArray(m.frames)) m.frames = m.frames.map((f) => Object.assign({}, f, { png: (f.png instanceof ArrayBuffer || ArrayBuffer.isView(f.png)) ? toB64(f.png.buffer || f.png) : f.png }));
    box.queue.push(m);
  });
  window.__pixelkiln = box;
})();
"""

var _active := false
var _dirty := false
var _menu_item_id := -1
## Roles of the frames the current project was opened with, in frame order.
var _frame_roles: Array = []


func _ready() -> void:
	if not OS.has_feature("web"):
		return
	JavaScriptBridge.eval(SHIM, true)
	_disable_disk_shortcuts()
	_remove_disk_menu_items()
	_menu_item_id = ExtensionsApi.menu.add_menu_item(ExtensionsApi.menu.FILE, MENU_LABEL, self)
	ExtensionsApi.signals.signal_project_data_changed(_on_project_data_changed)
	Global.config_cache.set_value("preferences", "startup", false)
	_hide_splash()
	_active = true
	_post({
		"type": "pixelkiln:ready",
		"version": PROTOCOL_VERSION,
		"editor": "pixelorama@" + str(ProjectSettings.get_setting("application/config/version")),
		"api": ExtensionsApi.get_api_version(),
	})


func _process(_delta: float) -> void:
	if not _active:
		return
	var raw = JavaScriptBridge.eval("window.__pixelkiln.take()", true)
	if typeof(raw) != TYPE_STRING or raw == "[]":
		return
	var messages = JSON.parse_string(raw)
	if typeof(messages) != TYPE_ARRAY:
		return
	for message in messages:
		if typeof(message) == TYPE_DICTIONARY:
			_handle(message)


func _unhandled_key_input(event: InputEvent) -> void:
	if not _active or not (event is InputEventKey):
		return
	var key := event as InputEventKey
	if key.pressed and not key.echo and key.keycode == KEY_S and (key.ctrl_pressed or key.meta_pressed):
		get_viewport().set_input_as_handled()
		_save("shortcut")


## Called by Pixelorama when the File menu item is chosen (see TopMenuContainer).
func menu_item_clicked() -> void:
	_save("menu")


func _handle(message: Dictionary) -> void:
	var request := str(message.get("request", ""))
	match str(message.get("type", "")):
		"pixelkiln:open":
			_open(message, request)
		"pixelkiln:request-save":
			_save(request)
		_:
			_post_error("unknown message type: %s" % str(message.get("type", "")), request)


func _open(message: Dictionary, request: String) -> void:
	var png := Marshalls.base64_to_raw(str(message.get("png", "")))
	var pxo := Marshalls.base64_to_raw(str(message.get("pxo", "")))
	var frames: Array = message.get("frames", []) if typeof(message.get("frames")) == TYPE_ARRAY else []
	if png.is_empty() and pxo.is_empty() and frames.is_empty():
		_post_error("open needs png, frames, or pxo bytes", request)
		return
	var asset: Dictionary = message.get("asset", {}) if typeof(message.get("asset")) == TYPE_DICTIONARY else {}
	var name := str(asset.get("name", "pixelkiln")).replace("/", "-")
	if not name.is_valid_filename():
		name = "pixelkiln"
	_frame_roles = []
	for frame in frames:
		_frame_roles.append(frame.get("role") if typeof(frame) == TYPE_DICTIONARY and frame.get("role") != null else null)
	var source := ""
	if not pxo.is_empty() and _open_pxo(pxo, name):
		source = "pxo"
	elif not frames.is_empty():
		var error := _open_frames(frames, name, message.get("fps"))
		if error != "":
			_post_error(error, request)
			return
		source = "frames"
	else:
		if png.is_empty():
			_post_error("could not open the project file and no png was given", request)
			return
		var image := Image.new()
		var err := image.load_png_from_buffer(png)
		if err != OK:
			_post_error("could not decode PNG: %s" % error_string(err), request)
			return
		OpenSave.open_image_as_new_tab(name + ".png", image)
		source = "png"
	var project := Global.current_project
	_load_palette(message.get("palette"), name)
	project.has_changed = false
	_set_dirty(false)
	_post({
		"type": "pixelkiln:opened",
		"request": request,
		"width": project.size.x,
		"height": project.size.y,
		"source": source,
		"layers": project.layers.size(),
		"frames": project.frames.size(),
	})


## One project with a frame per member, one layer, at the members' shared
## size — what `open_image_as_new_tab` does for one image, for a set. Returns
## an error message, or "" once the project is the current tab.
func _open_frames(frames: Array, name: String, fps) -> String:
	var images: Array[Image] = []
	for frame in frames:
		if typeof(frame) != TYPE_DICTIONARY:
			return "every frame needs {role, png}"
		var bytes := Marshalls.base64_to_raw(str(frame.get("png", "")))
		var image := Image.new()
		var err := image.load_png_from_buffer(bytes)
		if err != OK:
			return "could not decode frame %d: %s" % [images.size(), error_string(err)]
		if not images.is_empty() and image.get_size() != images[0].get_size():
			return "frame %d is %dx%d; the first frame is %dx%d" % [images.size(), image.get_width(), image.get_height(), images[0].get_width(), images[0].get_height()]
		images.append(image)
	if images.is_empty():
		return "frames is empty"
	var project := Project.new([], name, images[0].get_size())
	var layer := PixelLayer.new(project)
	project.layers.append(layer)
	Global.projects.append(project)
	for image in images:
		var frame := Frame.new()
		image.convert(project.get_image_format())
		frame.cels.append(layer.new_cel_from_image(image))
		project.frames.append(frame)
	if typeof(fps) == TYPE_FLOAT or typeof(fps) == TYPE_INT:
		if fps > 0:
			project.fps = float(fps)
	OpenSave.set_new_imported_tab(project, name + ".png")
	return ""


## Restore a project file a previous save returned. Opened as a new tab rather
## than into the empty one, so a file Pixelorama cannot read leaves nothing
## half-cleared behind; the empty tab is dropped afterwards, as an import does.
## Opened as a "backup" so Pixelorama neither rewrites the File menu items
## this bridge removed nor records the temp path as the last project.
func _open_pxo(pxo: PackedByteArray, name: String) -> bool:
	if DirAccess.make_dir_recursive_absolute(PXO_OPEN_DIR) != OK:
		return false
	var path := PXO_OPEN_DIR + "/" + name + ".pxo"
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return false
	file.store_buffer(pxo)
	file.close()
	var previous_empty := Global.current_project.is_empty()
	var previous_index := Global.current_project_index
	var count := Global.projects.size()
	OpenSave.open_pxo_file(path, true, false)
	if Global.projects.size() != count + 1:
		return false
	var project: Project = Global.projects[count]
	if project.frames.is_empty() or project.layers.is_empty():
		return false
	project.backup_path = ""
	project.export_profile.file_name = name
	project.was_exported = true
	if previous_empty:
		Global.tabs.delete_tab(previous_index)
	return true


func _load_palette(palette, name: String) -> void:
	if typeof(palette) != TYPE_ARRAY or (palette as Array).is_empty():
		return
	var colors: Array = []
	var index := 0
	for value in palette:
		var text := str(value)
		if not Color.html_is_valid(text):
			continue
		colors.append({"color": Color.html(text), "index": index})
		index += 1
	if colors.is_empty():
		return
	ExtensionsApi.palette.create_palette_from_data(
		name,
		{"comment": "PixelKiln style palette", "width": colors.size(), "height": 1, "colors": colors},
		false
	)


func _save(request: String) -> void:
	var project := Global.current_project
	if project == null or project.frames.is_empty():
		_post_error("nothing to save", request)
		return
	var frames: Array = []
	for index in project.frames.size():
		var image := Image.create(project.size.x, project.size.y, false, Image.FORMAT_RGBA8)
		DrawingAlgos.blend_layers(image, project.frames[index], Vector2i.ZERO, project)
		frames.append({
			"role": _frame_roles[index] if index < _frame_roles.size() else null,
			"png": Marshalls.raw_to_base64(image.save_png_to_buffer()),
		})
	var pxo := PackedByteArray()
	if OpenSave.save_pxo_file(PXO_TMP, true, false, project):
		pxo = FileAccess.get_file_as_bytes(PXO_TMP)
	_post({
		"type": "pixelkiln:save",
		"request": request,
		"width": project.size.x,
		"height": project.size.y,
		"png": frames[0]["png"],
		"frames": frames,
		"pxo": Marshalls.raw_to_base64(pxo),
	})
	project.has_changed = false
	_set_dirty(false)


func _on_project_data_changed(_project) -> void:
	_set_dirty(true)


func _set_dirty(value: bool) -> void:
	if _dirty == value:
		return
	_dirty = value
	_post({"type": "pixelkiln:dirty", "dirty": value})


func _post(message: Dictionary) -> void:
	var json := JSON.stringify(message)
	JavaScriptBridge.eval("window.__pixelkiln.post(" + JSON.stringify(json) + ")", true)


func _post_error(text: String, request := "") -> void:
	var message := {"type": "pixelkiln:error", "message": text}
	if request != "":
		message["request"] = request
	_post(message)


## The page owns the file; Pixelorama's own open/save/export would only reach
## a browser download dialog here, and quitting would leave a dead canvas in
## the host's sheet.
func _remove_disk_menu_items() -> void:
	for id in [
		Global.FileMenu.OPEN,
		Global.FileMenu.OPEN_LAST_PROJECT,
		Global.FileMenu.RECENT,
		Global.FileMenu.SAVE,
		Global.FileMenu.SAVE_AS,
		Global.FileMenu.EXPORT,
		Global.FileMenu.EXPORT_AS,
		Global.FileMenu.QUIT,
	]:
		ExtensionsApi.menu.remove_menu_item(ExtensionsApi.menu.FILE, id)


func _disable_disk_shortcuts() -> void:
	for action in ["open_file", "save_file", "save_file_as", "export_file", "export_file_as", "open_last_project"]:
		if InputMap.has_action(action):
			InputMap.action_erase_events(action)


func _hide_splash() -> void:
	# The splash is shown by the main scene after its own _ready; give it a
	# frame to appear, then close it. Harmless when it was never shown.
	await get_tree().process_frame
	await get_tree().process_frame
	var splash := Global.control.find_child("SplashDialog", true, false)
	if splash != null and splash is Window and (splash as Window).visible:
		(splash as Window).hide()
