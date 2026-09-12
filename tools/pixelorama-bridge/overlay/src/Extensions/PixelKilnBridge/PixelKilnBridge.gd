extends Node
## PixelKiln host bridge.
##
## The gallery embeds Pixelorama in an iframe and talks to it over
## `postMessage`; this node is the Pixelorama side of that conversation. It
## is an internal extension of the PixelKiln build (see `_add_internal_extensions`
## in HandleExtensions.gd) and does nothing outside a web export.
##
## Protocol (all messages carry `type: "pixelkiln:<name>"`; same origin only):
##   host → editor   open          { request, asset: {key, id, name, width, height}, png: ArrayBuffer, palette: [#rrggbb] }
##   host → editor   request-save  { request }
##   editor → host   ready         { version, editor }
##   editor → host   opened        { request, width, height }
##   editor → host   dirty         { dirty }
##   editor → host   save          { request, width, height, png: ArrayBuffer, pxo: ArrayBuffer }
##   editor → host   error         { request?, message }
##
## Bytes cross the JavaScript boundary as base64 inside a small shim this
## node installs on `window.__pixelkiln`; the shim converts to and from
## ArrayBuffers so the page-facing protocol stays binary.

const PROTOCOL_VERSION := 1
const PXO_TMP := "user://pixelkiln-edit.pxo"
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
      if (window.parent && window.parent !== window) window.parent.postMessage(m, window.location.origin, transfer); } };
  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin || !e.data || typeof e.data.type !== "string" || !e.data.type.startsWith("pixelkiln:")) return;
    const m = Object.assign({}, e.data);
    if (m.png instanceof ArrayBuffer || ArrayBuffer.isView(m.png)) m.png = toB64(m.png.buffer || m.png);
    box.queue.push(m);
  });
  window.__pixelkiln = box;
})();
"""

var _active := false
var _dirty := false
var _menu_item_id := -1


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
	if png.is_empty():
		_post_error("open needs png bytes", request)
		return
	var image := Image.new()
	var err := image.load_png_from_buffer(png)
	if err != OK:
		_post_error("could not decode PNG: %s" % error_string(err), request)
		return
	var asset: Dictionary = message.get("asset", {}) if typeof(message.get("asset")) == TYPE_DICTIONARY else {}
	var name := str(asset.get("name", "pixelkiln")).replace("/", "-")
	if not name.is_valid_filename():
		name = "pixelkiln"
	OpenSave.open_image_as_new_tab(name + ".png", image)
	var project := Global.current_project
	_load_palette(message.get("palette"), name)
	project.has_changed = false
	_set_dirty(false)
	_post({
		"type": "pixelkiln:opened",
		"request": request,
		"width": image.get_width(),
		"height": image.get_height(),
	})


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
	var image := Image.create(project.size.x, project.size.y, false, Image.FORMAT_RGBA8)
	DrawingAlgos.blend_layers(image, project.frames[0], Vector2i.ZERO, project)
	var png := image.save_png_to_buffer()
	var pxo := PackedByteArray()
	if OpenSave.save_pxo_file(PXO_TMP, true, false, project):
		pxo = FileAccess.get_file_as_bytes(PXO_TMP)
	_post({
		"type": "pixelkiln:save",
		"request": request,
		"width": project.size.x,
		"height": project.size.y,
		"png": Marshalls.raw_to_base64(png),
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
## a browser download dialog here.
func _remove_disk_menu_items() -> void:
	for id in [
		Global.FileMenu.OPEN,
		Global.FileMenu.OPEN_LAST_PROJECT,
		Global.FileMenu.RECENT,
		Global.FileMenu.SAVE,
		Global.FileMenu.SAVE_AS,
		Global.FileMenu.EXPORT,
		Global.FileMenu.EXPORT_AS,
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
