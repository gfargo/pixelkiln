"""Parallax experiments on flattened pixel-art backgrounds.

Research script for docs/RESEARCH_PARALLAX.md. Rough, takes paths as arguments.

    python3 parallax.py seam <png>...                       how badly each image wraps
    python3 parallax.py loop <png> <out.png> <method>       make it wrap: cut, crossfade or mirror
    python3 parallax.py split <png> <out-dir> <bands> [depth.png]
                                                            cut into depth layers along skylines
    python3 parallax.py cut <png> <out-dir> <bands> <depth.png> [reach]
                                                            cut into depth layers pixel by pixel, fill within reach
    python3 parallax.py preview <out.gif> <f0,f1,...> <layer.png>...
                                                            pan a camera over layers
    python3 parallax.py line <png> <out.gif> <horizon-row>  per-row (raster) scroll of one image
    python3 parallax.py scroll <out.gif> <f0,f1,...> <height> <png>@<bottom-row>...
                                                            stack wrapping layers and scroll one way
    python3 parallax.py jitter                              rounding schemes, numbers only
    python3 parallax.py haze <png> <out.png> <t>            push an image toward its sky colour, palette held
    python3 parallax.py bands <png> <bands> [depth.png]     contrast and sky distance per depth band
    python3 parallax.py compose <out.gif> <sky,far,near> <seed> <sprite.png>...
                                                            layers built from separate silhouettes, camera pans up
    python3 parallax.py screen <png>...                     numbers for choosing between candidates
    python3 parallax.py foot <png> <out.png> <frac>         trim, then dither the bottom frac out
    python3 parallax.py tint <png> <out.png> <#hex> <t> <palette.json|png>
                                                            mix toward a colour, snap to a biome palette
    python3 parallax.py sky <out.png> <w> <h> <#hex,#hex,...>
                                                            flat sky bands with dithered steps
    python3 parallax.py skyline <out.gif|webp> <spec.json>  side-scrolling preview of runs and layers
    python3 parallax.py climb <out.gif|webp> <spec.json>    vertical preview: the camera climbs through the layers
    python3 parallax.py wall <png> <out.png> <height> <cap-rows>
                                                            stack a cliff into a tall wall, looping its body
    python3 parallax.py sheet <out.png> <cols> <#bg> <png>...
                                                            transparent pictures in a grid, enlarged twice

Needs numpy, pillow and scipy.
"""

import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import median_filter


def load(path):
    img = Image.open(path).convert("RGBA")
    return np.asarray(img).astype(np.int16)


def save(arr, path, scale=1):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA" if arr.shape[2] == 4 else "RGB")
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    img.save(path)


def colours(rgb):
    flat = rgb.reshape(-1, rgb.shape[-1])
    return {tuple(c) for c in np.unique(flat, axis=0)}


def palette_snap(rgb, palette):
    pal = np.array(sorted(palette), dtype=np.int32)
    flat = rgb.reshape(-1, 3).astype(np.int32)
    out = np.empty_like(flat)
    for i in range(0, len(flat), 4096):
        chunk = flat[i : i + 4096]
        d = ((chunk[:, None, :] - pal[None, :, :]) ** 2).sum(-1)
        out[i : i + 4096] = pal[d.argmin(1)]
    return out.reshape(rgb.shape)


# --- wrapping -------------------------------------------------------------


def column_diff(a, b):
    """Mean absolute difference between two columns, 0-255, over RGB weighted by alpha and
    alpha itself, so a transparent pixel matches only another transparent pixel."""
    def pre(c):
        c = c.astype(int)
        return np.concatenate([c[:, :3] * c[:, 3:4] // 255, c[:, 3:4]], axis=1)
    return float(np.abs(pre(a) - pre(b)).mean())


def seam_ratio(rgba):
    """Wrap seam (last column against first) over the median step between neighbouring columns.

    1.0 means the wrap is as smooth as the inside of the picture.
    """
    w = rgba.shape[1]
    inner = [column_diff(rgba[:, x], rgba[:, x + 1]) for x in range(w - 1)]
    seam = column_diff(rgba[:, w - 1], rgba[:, 0])
    return seam, float(np.median(inner)), seam / max(float(np.median(inner)), 1e-6)


def cmd_seam(paths):
    print(f"{'image':70} {'seam':>6} {'inner':>6} {'ratio':>6}")
    for p in paths:
        s, m, r = seam_ratio(load(p))
        print(f"{p:70} {s:6.1f} {m:6.1f} {r:6.1f}")


def best_cut(rgba, min_frac=0.6):
    """The pair of columns i < j, at least min_frac of the width apart, where column j-1 best
    continues into column i. Cropping to [i, j) then wraps with no new pixels."""
    h, w = rgba.shape[:2]
    cols = rgba[:, :, :3].astype(int)
    best = None
    for i in range(0, w):
        for j in range(i + int(w * min_frac), w + 1):
            d = column_diff(rgba[:, j - 1], rgba[:, i])
            if best is None or d < best[0]:
                best = (d, i, j)
    return best


def cmd_loop(src, out, method):
    rgba = load(src)
    h, w = rgba.shape[:2]
    before = seam_ratio(rgba)[2]
    pal = colours(rgba[:, :, :3])
    if method == "cut":
        d, i, j = best_cut(rgba)
        res = rgba[:, i:j]
        note = f"columns {i}..{j} ({j - i} of {w} wide)"
    elif method == "crossfade":
        # Blend the last k columns into the first k, drop the last k, snap back to the palette.
        k = w // 8
        t = (np.arange(k) + 0.5) / k  # 0 at the seam side -> 1 inside
        head = rgba[:, :k, :3].astype(float)
        tail = rgba[:, w - k :, :3].astype(float)
        blended = tail * (1 - t)[None, :, None] + head * t[None, :, None]
        res = rgba[:, : w - k].copy()
        res[:, :k, :3] = palette_snap(np.round(blended).astype(int), pal)
        note = f"{k} column crossfade, snapped to the source palette"
    elif method == "mirror":
        res = np.concatenate([rgba, rgba[:, ::-1]], axis=1)
        note = "picture and its mirror image side by side"
    else:
        raise SystemExit(f"unknown method {method}")
    after = seam_ratio(res)[2]
    new = len(colours(res[:, :, :3]) - pal)
    save(res, out)
    # A picture of the wrap: the result twice, side by side, so the seam is visible in the middle.
    save(np.concatenate([res, res], axis=1), out.replace(".png", ".twice.png"))
    print(f"{method}: {note}; seam ratio {before:.1f} -> {after:.1f}; new colours {new}")


# --- depth and splitting --------------------------------------------------


def sky_colour(rgba):
    top = rgba[: max(2, rgba.shape[0] // 64), :, :3].reshape(-1, 3)
    return np.median(top, axis=0)


def nearness(rgba, depth_path=None):
    """0 = far, 1 = near. From a depth model's output if given (brighter = nearer, as Depth
    Anything writes it), else from the distance to the sky colour."""
    if depth_path:
        d = np.asarray(Image.open(depth_path).convert("L").resize(rgba.shape[1::-1], Image.BILINEAR)).astype(float)
    else:
        sky = sky_colour(rgba)
        d = np.sqrt(((rgba[:, :, :3] - sky) ** 2).sum(-1))
    d = median_filter(d, size=5)
    d = (d - d.min()) / max(d.max() - d.min(), 1e-6)
    return d


def thresholds(near, bands):
    """1D k-means on nearness; returns band-1 cut points."""
    v = near.reshape(-1)
    centres = np.quantile(v, (np.arange(bands) + 0.5) / bands)
    for _ in range(30):
        lab = np.abs(v[:, None] - centres[None]).argmin(1)
        centres = np.array([v[lab == k].mean() if (lab == k).any() else centres[k] for k in range(bands)])
    centres.sort()
    return (centres[:-1] + centres[1:]) / 2


def skylines(near, cuts, run=3):
    """For each cut, the first row in each column where nearness stays at or above it for `run`
    rows. Smoothed with a median along x and kept in order (nearer skylines never above farther)."""
    h, w = near.shape
    lines = []
    for t in cuts:
        above = near >= t
        s = np.full(w, h)
        for x in range(w):
            col = above[:, x]
            for y in range(h - run + 1):
                if col[y : y + run].all():
                    s[x] = y
                    break
        s = median_filter(s, size=5, mode="nearest")
        # GROW lifts each skyline so a near shape takes its own outline with it when it moves.
        s = np.maximum(s - int(os.environ.get("GROW", "0")), 0)
        if lines:
            s = np.maximum(s, lines[-1])
        lines.append(s)
    return lines


def mirror_fill(layer_rgb, top, bottom):
    """Fill rows [bottom(x), h) of each column by reflecting the layer's own rows upward from
    bottom(x), so a revealed gap shows the layer's texture, not a smear."""
    h, w = layer_rgb.shape[:2]
    out = layer_rgb.copy()
    for x in range(w):
        t, b = int(top[x]), int(bottom[x])
        span = b - t
        if span <= 0:
            # Nothing of this layer is visible in this column; borrow the nearest column's colour.
            continue
        for y in range(b, h):
            k = (y - b) % (2 * span)
            src = b - 1 - k if k < span else t + (k - span)
            out[y, x] = layer_rgb[src, x]
    # Columns with no visible pixels: copy from the nearest column that has some.
    empty = [x for x in range(w) if bottom[x] - top[x] <= 0]
    full = [x for x in range(w) if bottom[x] - top[x] > 0]
    for x in empty:
        if not full:
            break
        n = min(full, key=lambda f: abs(f - x))
        out[int(top[x]) :, x] = out[int(top[x]) :, n]
    return out


def revealed(lines, h, shift):
    """Pixels of each layer that are not in the source but come into view when the layer in
    front of it moves `shift` pixels sideways relative to it. Upper bound: assumes every layer
    in front moves by the full shift."""
    out = []
    for k in range(len(lines) + 1):
        if k == len(lines):
            out.append(0)
            continue
        front = lines[k]
        lo = front.copy()
        for dx in range(-shift, shift + 1):
            lo = np.minimum(lo, np.roll(front, dx))
        # Revealed rows in column x: from the front skyline down to where the shifted front's
        # skyline would be at most. Approximate: max skyline of the window minus this one.
        hi = front.copy()
        for dx in range(-shift, shift + 1):
            hi = np.maximum(hi, np.roll(front, dx))
        out.append(int((hi - front).clip(0).sum()))
    return out


def cmd_split(src, out_dir, bands, depth_path=None):
    os.makedirs(out_dir, exist_ok=True)
    rgba = load(src)
    h, w = rgba.shape[:2]
    near = nearness(rgba, depth_path)
    cuts = thresholds(near, bands)
    lines = skylines(near, cuts)
    tops = [np.zeros(w, int)] + lines
    bottoms = lines + [np.full(w, h)]
    layers = []
    fill_overlay = rgba.copy()
    for k in range(bands):
        layer = mirror_fill(rgba[:, :, :3], tops[k], bottoms[k])
        alpha = np.zeros((h, w), np.int16)
        for x in range(w):
            alpha[int(tops[k][x]) :, x] = 255
        arr = np.dstack([layer, alpha])
        save(arr, os.path.join(out_dir, f"layer{k}.png"))
        layers.append(arr)
    # Check: composited at rest, the layers are the source, pixel for pixel.
    comp = np.zeros_like(rgba)
    for arr in layers:
        m = arr[:, :, 3] > 0
        comp[m] = arr[m]
    exact = bool((comp[:, :, :3] == rgba[:, :, :3]).all())
    # Pictures: nearness, and the bands coloured.
    save(np.dstack([np.repeat((near * 255)[:, :, None], 3, 2), np.full((h, w), 255)]), os.path.join(out_dir, "nearness.png"), 2)
    tint = np.array([[70, 110, 220], [80, 200, 120], [240, 200, 60], [230, 90, 70], [190, 80, 200], [60, 200, 210]])
    band_img = rgba.copy()
    for k in range(bands):
        for x in range(w):
            band_img[int(tops[k][x]) : int(bottoms[k][x]), x, :3] = (
                band_img[int(tops[k][x]) : int(bottoms[k][x]), x, :3] * 0.45 + tint[k] * 0.55
            ).astype(int)
    save(band_img, os.path.join(out_dir, "bands.png"), 2)
    area = [int((bottoms[k] - tops[k]).clip(0).sum()) for k in range(bands)]
    rev = revealed(lines, h, max(8, w // 12))
    print(f"{src}: {bands} bands, cuts {np.round(cuts, 2).tolist()}, recomposite exact: {exact}")
    for k in range(bands):
        invented = rev[k] / max(area[k], 1)
        print(f"  layer{k}: {area[k] / (h * w):5.1%} of the picture, made-up pixels at a {max(8, w // 12)} px relative shift: {rev[k]} ({invented:.1%} of the layer)")


def cmd_cut(src, out_dir, bands, depth_path, reach="32"):
    """Per-pixel layers: each pixel goes to its depth band, not to a column's skyline.

    Floating things (a plume, a cloud) keep their own band and the sky behind them stays sky.
    Each layer is filled only where it could be uncovered: hidden pixels within `reach` px of
    something at its depth or farther. The fill copies the nearest pixel of the layer's own in
    the same row, then the nearest in any direction. GROW px of each near band are taken from
    the bands behind it so outlines travel with their shapes. Writes layer0..N-1.png,
    layerK.fill.png (the invented pixels as a white-on-black mask) and bands.png.
    """
    from scipy.ndimage import binary_dilation, distance_transform_edt

    os.makedirs(out_dir, exist_ok=True)
    rgba = load(src)
    h, w = rgba.shape[:2]
    near = nearness(rgba, depth_path)
    cuts = thresholds(near, bands)
    label = np.digitize(near, cuts)
    label = median_filter(label, size=3)
    grow = int(os.environ.get("GROW", "0"))
    if grow:
        ball = np.ones((2 * grow + 1, 2 * grow + 1), bool)
        for k in range(1, bands):
            spread = binary_dilation(label == k, ball) & (label < k)
            label[spread] = k
    reach = int(reach)
    box = np.ones((2 * reach + 1, 2 * reach + 1), bool)
    rgb = rgba[:, :, :3]
    invented_total = 0
    for k in range(bands):
        own = label == k
        hidden = label > k
        if k == 0:
            need = hidden  # the sky must be complete
        else:
            need = hidden & binary_dilation(label <= k, box)
        layer = np.zeros((h, w, 4), np.int16)
        layer[own, :3] = rgb[own]
        layer[own, 3] = 255
        if own.any() and need.any():
            # Same row first: copy from the nearest pixel of this layer to the left or right.
            filled = np.zeros((h, w), bool)
            for y in np.nonzero(need.any(1))[0]:
                xs = np.nonzero(own[y])[0]
                if len(xs) == 0:
                    continue
                for x in np.nonzero(need[y])[0]:
                    j = xs[np.abs(xs - x).argmin()]
                    layer[y, x, :3] = rgb[y, j]
                    filled[y, x] = True
            rest = need & ~filled
            if rest.any():
                _, (iy, ix) = distance_transform_edt(~own, return_indices=True)
                layer[rest, :3] = rgb[iy[rest], ix[rest]]
            layer[need, 3] = 255
        invented = int(need.sum())
        invented_total += invented
        save(layer, os.path.join(out_dir, f"layer{k}.png"))
        # The invented pixels as a mask, white = made up: what an inpainting model should redo.
        mask = np.zeros((h, w, 4), np.int16)
        mask[:, :, 3] = 255
        mask[need, :3] = 255
        save(mask, os.path.join(out_dir, f"layer{k}.fill.png"))
        print(f"  layer{k}: {own.mean():5.1%} of the picture, invented {invented} px ({invented / max(own.sum(), 1):.0%} of its own)")
    comp = np.zeros_like(rgba)
    for k in range(bands):
        arr = load(os.path.join(out_dir, f"layer{k}.png"))
        m = arr[:, :, 3] > 0
        comp[m] = arr[m]
    exact = bool((comp[:, :, :3] == rgb).all())
    tint = np.array([[70, 110, 220], [80, 200, 120], [240, 200, 60], [230, 90, 70], [190, 80, 200]])
    band_img = rgba.copy()
    band_img[:, :, :3] = (rgb * 0.45 + tint[label] * 0.55).astype(int)
    save(band_img, os.path.join(out_dir, "bands.png"), 2)
    print(f"{src}: {bands} bands per pixel, grow {grow}, reach {reach}; recomposite exact: {exact}; invented {invented_total} px in all")


# --- animation ------------------------------------------------------------


def composite(layers, offsets, view_w, x0):
    h = layers[0].shape[0]
    frame = np.zeros((h, view_w, 3), np.int16)
    for arr, off in zip(layers, offsets):
        w = arr.shape[1]
        xs = (np.arange(view_w) + x0 + off) % w
        part = arr[:, xs]
        m = part[:, :, 3] > 0
        frame[m] = part[:, :, :3][m]
    return frame


def write_gif(frames, out, scale=None, ms=33):
    # SCALE enlarges small previews with nearest neighbour, so they read on a page.
    scale = scale or int(os.environ.get("SCALE", "1"))
    imgs = []
    for f in frames:
        im = Image.fromarray(f.astype(np.uint8), "RGB")
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        if out.endswith(".webp"):
            imgs.append(im)
        else:
            imgs.append(im.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
    if out.endswith(".webp"):
        # Lossless animated WebP: the same pixels as a GIF, about 2.5 times smaller on these.
        imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=ms, loop=0, lossless=True, method=6)
        return
    imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=ms, loop=0, optimize=True)


def camera_path(span, frames):
    """Ping-pong pan over `span` pixels, eased, in whole pixels."""
    t = np.linspace(0, 2 * np.pi, frames, endpoint=False)
    return np.round((1 - np.cos(t)) / 2 * span).astype(int)


def cmd_preview(out, factors, paths):
    layers = [load(p) for p in paths]
    factors = [float(f) for f in factors.split(",")]
    w = layers[0].shape[1]
    span = w // 4
    view_w = w - span
    frames = []
    for cam in camera_path(span, 60):
        # Whole-pixel camera first, then each layer's offset from it (see `jitter`).
        offs = [int(np.floor(cam * f)) for f in factors]
        frames.append(composite(layers, offs, view_w, 0))
    write_gif(frames, out)
    save(np.dstack([frames[len(frames) // 2], np.full(frames[0].shape[:2], 255)]), out.replace(".gif", ".mid.png"), 2)
    print(f"{out}: {len(frames)} frames, factors {factors}, view {view_w} px over a {span} px pan")


def cmd_line(src, out, horizon):
    rgba = load(src)
    h, w = rgba.shape[:2]
    span = w // 4
    view_w = w - span
    horizon = int(horizon)
    far = 0.15
    rows = np.arange(h)
    depth = np.clip((rows - horizon) / max(h - 1 - horizon, 1), 0, 1)
    f = np.where(rows < horizon, far, far + (1 - far) * depth**1.5)
    frames = []
    for cam in camera_path(span, 60):
        frame = np.zeros((h, view_w, 3), np.int16)
        for y in range(h):
            off = int(np.floor(cam * f[y]))
            frame[y] = rgba[y, off : off + view_w, :3]
        frames.append(frame)
    write_gif(frames, out)
    save(np.dstack([frames[len(frames) // 4], np.full(frames[0].shape[:2], 255)]), out.replace(".gif", ".quarter.png"), 2)
    print(f"{out}: line scroll, rows above {horizon} at {far}, the bottom row at 1.0")


def cmd_scroll(out, factors, height, specs):
    """Stack layers that are meant to wrap and scroll the camera one way, so every seam passes.

    Each spec is <png>@<bottom-row>: the layer is drawn with its bottom edge on that row of a
    canvas `height` tall. The first layer is the sky and is extended down by repeating its last
    row. The camera moves 4 px a frame for 100 frames; each layer moves floor(cam x factor).
    """
    factors = [float(f) for f in factors.split(",")]
    height = int(height)
    layers = []
    for spec in specs:
        path, bottom = spec.rsplit("@", 1)
        arr = load(path)
        h, w = arr.shape[:2]
        canvas = np.zeros((height, w, 4), np.int16)
        top = int(bottom) - h
        canvas[max(top, 0) : int(bottom)] = arr[max(-top, 0) :]
        if not layers:
            canvas[int(bottom) :] = arr[-1]
        layers.append(canvas)
    view_w = min(a.shape[1] for a in layers)
    frames = []
    for i in range(100):
        cam = i * 4
        frames.append(composite(layers, [int(np.floor(cam * f)) for f in factors], view_w, 0))
    write_gif(frames, out)
    print(f"{out}: {len(frames)} frames, factors {factors}, {view_w}x{height}")


# --- rounding -------------------------------------------------------------


def cmd_jitter():
    fps = 60
    n = 6 * fps
    # A camera that follows a player who walks right, stops, and the camera settles with a small overshoot.
    target = np.concatenate([np.linspace(0, 120, 3 * fps), np.full(3 * fps, 120.0)])
    cam = np.zeros(n)
    vel = 0.0
    for i in range(1, n):
        acc = 0.02 * (target[i] - cam[i - 1]) - 0.18 * vel
        vel += acc
        cam[i] = cam[i - 1] + vel
    fg = np.round(cam).astype(int)
    print("Camera: walks 120 px in 3 s, stops, settles with a small overshoot. 360 frames at 60 fps.")
    print(f"{'factor':>7} {'scheme':28} {'layer moves, camera still':>27} {'layer steps':>12}")
    for f in (0.1, 0.25, 0.3, 0.5, 0.6):
        schemes = {
            "round(cam * f)": np.round(cam * f).astype(int),
            "floor(round(cam) * f)": np.floor(fg * f).astype(int),
        }
        for name, lay in schemes.items():
            swim = int(((np.diff(lay) != 0) & (np.diff(fg) == 0)).sum())
            steps = int((np.diff(lay) != 0).sum())
            print(f"{f:7.2f} {name:28} {swim:27d} {steps:12d}")
    print()
    print("Step rhythm at a steady 1 px/frame camera, floor(round(cam) * f): frames between layer steps")
    cam = np.arange(0, 40)
    for f in (0.25, 0.3, 0.4, 0.5, 0.6, 0.75):
        lay = np.floor(cam * f).astype(int)
        idx = np.nonzero(np.diff(lay))[0]
        gaps = np.diff(idx).tolist()
        print(f"  f={f:4.2f}: {gaps[:12]}  {'even' if len(set(gaps)) == 1 else 'uneven'}")


# --- haze -----------------------------------------------------------------


def lum(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def cmd_bands(src, bands, depth_path=None):
    rgba = load(src)
    near = nearness(rgba, depth_path)
    cuts = thresholds(near, int(bands))
    lines = skylines(near, cuts)
    h, w = rgba.shape[:2]
    tops = [np.zeros(w, int)] + lines
    bottoms = lines + [np.full(w, h)]
    sky = sky_colour(rgba)
    print(f"{src}: sky {np.round(sky).astype(int).tolist()}")
    print(f"  {'band':>4} {'area':>6} {'lum sd':>7} {'to sky':>7} {'colours':>8}")
    for k in range(int(bands)):
        m = np.zeros((h, w), bool)
        for x in range(w):
            m[int(tops[k][x]) : int(bottoms[k][x]), x] = True
        px = rgba[:, :, :3][m].astype(float)
        if len(px) == 0:
            continue
        sd = float(lum(px).std())
        dist = float(np.sqrt(((px - sky) ** 2).sum(-1)).mean())
        n = len({tuple(c) for c in px.astype(int)})
        print(f"  {k:4d} {m.mean():6.1%} {sd:7.1f} {dist:7.1f} {n:8d}")


def cmd_haze(src, out, t):
    rgba = load(src)
    t = float(t)
    sky = sky_colour(rgba)
    pal = colours(rgba[:, :, :3])
    mixed = np.round(rgba[:, :, :3] * (1 - t) + sky * t).astype(int)
    snapped = palette_snap(mixed, pal)
    res = rgba.copy()
    res[:, :, :3] = snapped
    save(res, out)
    seen = rgba[:, :, 3] > 0
    sd0, sd1 = lum(rgba[:, :, :3][seen].astype(float)).std(), lum(snapped[seen].astype(float)).std()
    used0, used1 = len(colours(rgba[:, :, :3][seen])), len(colours(snapped[seen]))
    print(f"{out}: t={t}, luminance sd {sd0:.1f} -> {sd1:.1f}, colours used {used0} -> {used1}, none new")


# --- composite layers from sprites ---------------------------------------


def hexrgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], float)


def cmd_compose(out, rates, seed, paths):
    """Layers built from separate transparent silhouettes, not cut from one picture.

    A banded sky, two tiers of overlapping silhouettes (far one 40 px deeper and hazier), a
    thin strip of distant ground under the near tier, and the playfield in front. The camera
    pans north from the playfield's edge to look at the skyline. `rates` is sky,far,near: the
    fraction of the camera's movement each layer follows. Layers sit where they were placed
    when the view's top is at the playfield's edge and only rise from there, by at most
    (1 - rate) x the headroom.
    """
    sky_r, far_r, near_r = (float(v) for v in rates.split(","))
    rng = np.random.default_rng(int(seed))
    sprites = [Image.open(p).convert("RGBA") for p in paths]
    view_w, view_h, headroom = 640, 360, 360
    x0, x1 = -900, 900  # world x covered by the layers
    W = x1 - x0
    top, bottom = -900, 400  # world y covered
    H = bottom - top

    def world():
        return Image.new("RGBA", (W, H), (0, 0, 0, 0))

    def to_px(x, y):
        return int(x - x0), int(y - top)

    # Sky: four flat bands, top to horizon. Drawn per frame: its top rises, its foot stays.
    bands = [hexrgb(c) for c in ("#3e3f78", "#6a4f8a", "#b0668a", "#e48e7c")]
    dusk = hexrgb("#2a1830") / 255
    sky_top, sky_bottom = -250 - 560, 80

    def sky_rows(vy, lift):
        rows = np.zeros((view_h, 3))
        t0 = sky_top + lift
        for ry in range(view_h):
            t = np.clip((vy + ry - t0) / (sky_bottom - t0), 0, 0.999)
            rows[ry] = bands[int(t * 4)]
        return rows

    def tier(foot_y, haze):
        img = world()
        tint = np.array([1.0, 1.0, 1.0]) * (1 - haze) + dusk * haze
        x = -800 - rng.uniform(0, 64)
        last = -1
        while x < 800:
            pick = int(rng.integers(len(sprites)))
            if len(sprites) > 1 and pick == last:
                pick = (pick + 1) % len(sprites)
            last = pick
            s = sprites[pick]
            if rng.random() < 0.5:
                s = s.transpose(Image.FLIP_LEFT_RIGHT)
            a = np.asarray(s).astype(float)
            a[:, :, :3] *= tint  # a modulate multiplies, as an engine's tint does
            s = Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")
            y = foot_y - s.height + rng.uniform(-12, 12)
            img.alpha_composite(s, to_px(x, y))
            x += s.width * 0.72 + rng.uniform(0, 16)
        return img

    foot = -40
    far = tier(foot - 40, 0.5)
    near = tier(foot, 0.3)
    # The strip of distant ground under the near tier: its top rises with the tier, its foot
    # stays put, so a rising tier never opens a gap of sky above the playfield.
    ground_far = hexrgb("#4a3c38") * 0.8 + bands[3] * 0.2

    # The playfield, 1:1 with the camera: a ground with scattered tufts so its motion shows.
    play = np.zeros((H, W, 4), np.uint8)
    base = hexrgb("#4a6a44")
    for y in range(H):
        if y + top >= 0:
            play[y, :, :3] = base
            play[y, :, 3] = 255
    yy, xx = np.nonzero(play[:, :, 3])
    pick = rng.random(len(yy)) < 0.04
    play[yy[pick], xx[pick], :3] = hexrgb("#35512f")
    play[yy[pick] - 1, xx[pick], :3] = hexrgb("#6a8a5a")
    # A treeline along the playfield's north edge, in front of everything behind it.
    for tx in range(0, W, 9):
        th = int(rng.integers(70, 140))
        foot_px = int(-top + rng.integers(2, 10))
        col = hexrgb("#1f3a24") if rng.random() < 0.5 else hexrgb("#2c4f30")
        for k in range(th):
            half = int((k / th) * 14) // 2 + 1  # stepped widening toward the foot
            y = foot_px - th + k
            play[y, max(0, tx - half) : min(W, tx + half + 1), :3] = col
            play[y, max(0, tx - half) : min(W, tx + half + 1), 3] = 255
    play = Image.fromarray(play, "RGBA")

    def offset(rate, reach):
        return int(round((1 - rate) * reach))

    frames = []
    n = 60
    for i in range(n):
        t = (1 - np.cos(2 * np.pi * i / n)) / 2
        cam_top = int(round(40 - t * (40 + headroom)))  # view top, whole pixels first
        cam_x = int(round(-80 + 160 * t))
        reach = min(max(cam_top - 0, -headroom), 0)
        vx, vy = cam_x - view_w // 2, cam_top
        rows = sky_rows(vy, offset(sky_r, reach)).astype(np.uint8)
        frame = Image.fromarray(np.dstack([np.repeat(rows[:, None, :], view_w, 1), np.full((view_h, view_w), 255, np.uint8)]), "RGBA")

        def put(layer, dx, dy):
            frame.alpha_composite(layer.crop((vx - x0 - dx, vy - top - dy, vx - x0 - dx + view_w, vy - top - dy + view_h)))

        put(far, int(round((1 - far_r) * cam_x)), offset(far_r, reach))
        # Skirt: drawn straight into the frame, its top at the near tier's foot (risen), bottom fixed.
        s_top = foot - 12 - 24 + offset(near_r, reach)
        s_bot = foot + 12
        f = np.asarray(frame).copy()
        for wy in range(s_top - 12, s_bot + 12):
            ry = wy - vy
            if not (0 <= ry < view_h):
                continue
            if wy < s_top:
                alpha = (wy - (s_top - 12)) // 4 + 1  # 1..3 steps fading in
                a = alpha / 4
            elif wy >= s_bot:
                a = 1 - ((wy - s_bot) // 4 + 1) / 4
            else:
                a = 1.0
            f[ry, :, :3] = (f[ry, :, :3] * (1 - a) + ground_far * a).astype(np.uint8)
        frame = Image.fromarray(f, "RGBA")
        put(near, int(round((1 - near_r) * cam_x)), offset(near_r, reach))
        put(play, 0, 0)
        frames.append(np.asarray(frame.convert("RGB")).astype(np.int16))
    write_gif(frames, out)
    print(f"{out}: rates sky {sky_r}, far {far_r}, near {near_r}; lift at full headroom "
          f"{(1 - sky_r) * headroom:.0f}, {(1 - far_r) * headroom:.0f}, {(1 - near_r) * headroom:.0f} px")


# --- refined process: screen, fade the foot, tint, sky, skyline ---------------


BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]])


def palette_file(path):
    """A palette from a manifest (its first style's `palette`) or from a picture's colours."""
    if path.endswith(".json"):
        import json

        m = json.load(open(path))
        for s in m.get("styles", {}).values():
            if s.get("palette"):
                return {tuple(int(v) for v in hexrgb(c)) for c in s["palette"]}
        raise SystemExit(f"{path}: no style has a palette")
    return colours(load(path)[:, :, :3][load(path)[:, :, 3] > 0])


def cmd_screen(paths):
    """Numbers for choosing between candidates of one transparent layer or silhouette.

    edge: opaque pixels in the outer column on the left / right, as a share of the
    picture's height (a silhouette that touches the side was cut off by the canvas);
    top: opaque pixels on the first row; opaque: share of opaque pixels; colours used.
    """
    for p in paths:
        a = load(p)
        on = a[:, :, 3] > 0
        h, w = on.shape
        left, right, top = on[:, 0].mean(), on[:, -1].mean(), on[0].mean()
        rows = np.nonzero(on.any(1))[0]
        cols = np.nonzero(on.any(0))[0]
        box = f"x {cols[0]}..{cols[-1]}, y {rows[0]}..{rows[-1]}" if len(rows) else "empty"
        n = len(colours(a[:, :, :3][on])) if on.any() else 0
        print(f"{p}: edge {left:.2f}/{right:.2f}, top {top:.2f}, opaque {on.mean():.2f}, {n} colours, box {box}")


def cmd_foot(src, out, frac):
    """Trim to the opaque box, then fade the bottom `frac` of it out with a 4x4 ordered dither.

    Alpha stays 0 or 255, so the sprite is still pixel art: the fade is a thinning pattern,
    not soft alpha. Row by row the share of pixels kept falls from all to none.
    """
    a = load(src)
    on = a[:, :, 3] > 0
    rows = np.nonzero(on.any(1))[0]
    cols = np.nonzero(on.any(0))[0]
    a = a[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1].copy()
    h, w = a.shape[:2]
    band = max(1, int(round(h * float(frac))))
    for y in range(h - band, h):
        keep = 1 - (y - (h - band) + 1) / (band + 1)  # just under 1 -> just over 0
        thresh = BAYER4[y % 4][np.arange(w) % 4]
        drop = thresh >= keep * 16
        a[y, drop, 3] = 0
    save(a, out)
    print(f"{out}: {w}x{h}, bottom {band} rows dithered out")


def cmd_tint(src, out, hexc, t, pal_src):
    """Mix toward a colour (a haze or the sky's horizon) and snap to a biome palette.

    Unlike `haze`, the target colour is given, so it works on a transparent layer, and the
    snap is to the whole biome palette rather than to the layer's own colours.
    """
    a = load(src)
    pal = palette_file(pal_src)
    mixed = np.round(a[:, :, :3] * (1 - float(t)) + hexrgb(hexc) * float(t)).astype(int)
    res = a.copy()
    res[:, :, :3] = palette_snap(mixed, pal)
    save(res, out)
    on = a[:, :, 3] > 0
    sd0, sd1 = lum(a[:, :, :3][on].astype(float)).std(), lum(res[:, :, :3][on].astype(float)).std()
    print(f"{out}: toward {hexc} by {t}, luminance sd {sd0:.1f} -> {sd1:.1f}, {len(colours(res[:, :, :3][on]))} colours")


def sky_array(w, h, hexes, blend=8):
    """Flat colour bands, top to bottom, with an ordered-dither step between neighbours."""
    cols = [hexrgb(c) for c in hexes]
    n = len(cols)
    out = np.zeros((h, w, 4), np.int16)
    out[:, :, 3] = 255
    for y in range(h):
        pos = y / h * n
        i = min(int(pos), n - 1)
        frac = pos - i
        row = np.repeat(cols[i][None, :], w, 0)
        # Within `blend` rows of the next band, dither toward it.
        rows_left = (i + 1) * h / n - y
        if i < n - 1 and rows_left <= blend:
            share = 1 - rows_left / (blend + 1)
            mask = BAYER4[y % 4][np.arange(w) % 4] < share * 16
            row[mask] = cols[i + 1]
        out[y, :, :3] = row
    return out


def cmd_sky(out, w, h, hexes):
    save(sky_array(int(w), int(h), hexes.split(",")), out)
    print(f"{out}: {w}x{h}, {len(hexes.split(','))} bands")


def cmd_skyline(out, spec):
    """A side-scrolling preview: a sky, runs of silhouettes, whole layers, a ground strip.

    `spec` is a JSON file:
      {"view": [320, 180], "sky": ["#..", ...], "seed": 7, "frames": 120, "travel": 480,
       "layers": [
         {"run": ["a.png", "b.png"], "foot": 120, "speed": 0.25, "step": 0.72, "gap": 16, "jitter": 4},
         {"image": "near.png", "bottom": 180, "speed": 1.0},
         {"image": "volcano.png", "bottom": 170, "speed": 0.25, "repeat": false, "x": 200},
         {"fill": "#623e6a", "top": 140, "bottom": 180, "speed": 0.5}
       ]}
    An image layer repeats sideways at its own width unless `repeat` is false, when it is drawn
    once at `x` (a landmark). A fill is a flat band of one colour between `top` and `bottom`.
    A run is laid left to right, each sprite starting `step` of the way across the last plus up
    to `gap` px, flipped at random, never the same sprite twice in a row, its foot moved up to
    `jitter` px. An image layer repeats sideways at its own width. The camera moves `travel` px
    to the right and back, eased, in whole pixels; each layer moves floor(camera x speed).
    """
    import json

    cfg = json.load(open(spec))
    base = os.path.dirname(os.path.abspath(spec))
    vw, vh = cfg["view"]
    rng = np.random.default_rng(cfg.get("seed", 7))
    travel = cfg.get("travel", 480)
    world_w = vw + travel + 64

    def path(p):
        return p if os.path.isabs(p) else os.path.join(base, p)

    layers = []
    for spec_l in cfg["layers"]:
        canvas = np.zeros((vh, world_w, 4), np.int16)
        if "run" in spec_l:
            sprites = [load(path(p)) for p in spec_l["run"]]
            x = -int(rng.uniform(0, 32))
            last = -1
            while x < world_w:
                pick = int(rng.integers(len(sprites)))
                if len(sprites) > 1 and pick == last:
                    pick = (pick + 1) % len(sprites)
                last = pick
                s = sprites[pick][:, ::-1] if rng.random() < 0.5 else sprites[pick]
                sh, sw = s.shape[:2]
                y0 = spec_l["foot"] - sh + int(rng.integers(-spec_l.get("jitter", 0), spec_l.get("jitter", 0) + 1))
                for yy in range(sh):
                    cy = y0 + yy
                    if not 0 <= cy < vh:
                        continue
                    xs = np.arange(sw) + x
                    ok = (xs >= 0) & (xs < world_w) & (s[yy, :, 3] > 0)
                    canvas[cy, xs[ok]] = s[yy, ok]
                x += int(sw * spec_l.get("step", 0.72) + rng.uniform(0, spec_l.get("gap", 16)))
            canvas = canvas[:, : world_w]
        elif "image" in spec_l:
            img = load(path(spec_l["image"]))
            ih, iw = img.shape[:2]
            top = spec_l["bottom"] - ih
            if spec_l.get("repeat", True):
                reps = int(np.ceil(world_w / iw)) + 1
                strip = np.concatenate([img] * reps, axis=1)[:, :world_w]
            else:  # a landmark: drawn once, `x` px from the world's left edge
                strip = np.zeros((ih, world_w, 4), np.int16)
                x = spec_l.get("x", 0)
                strip[:, x : x + iw] = img[:, : max(0, min(iw, world_w - x))]
            # The layer may hang off the top or the bottom of the view: copy the overlap only.
            y0, y1 = max(top, 0), min(spec_l["bottom"], vh)
            if y1 > y0:
                canvas[y0:y1] = strip[y0 - top : y1 - top]
            if spec_l.get("extend"):
                canvas[spec_l["bottom"] :] = strip[-1]
        elif "fill" in spec_l:
            y0, y1 = spec_l["top"], spec_l.get("bottom", vh)
            canvas[y0:y1, :, :3] = hexrgb(spec_l["fill"])
            canvas[y0:y1, :, 3] = 255
        layers.append((canvas, spec_l["speed"]))
    sky = sky_array(vw, vh, cfg["sky"])
    frames = []
    n = cfg.get("frames", 120)
    for i in range(n):
        cam = int(round((1 - np.cos(2 * np.pi * i / n)) / 2 * travel))
        frame = sky[:, :, :3].copy()
        for canvas, speed in layers:
            off = int(np.floor(cam * speed))
            part = canvas[:, off : off + vw]
            m = part[:, :, 3] > 0
            frame[m] = part[:, :, :3][m]
        frames.append(frame)
    write_gif(frames, out)
    still = os.environ.get("STILL")
    if still:
        save(np.dstack([frames[0], np.full(frames[0].shape[:2], 255)]), still, int(os.environ.get("SCALE", "1")))
    print(f"{out}: {n} frames, {vw}x{vh}, travel {travel}px, speeds {[s for _, s in layers]}")


def cmd_wall(src, out, height, cap):
    """Stack a generated cliff into a wall `height` rows tall, its summit on top.

    The cliff is trimmed to its opaque box. Its top `cap` rows stay on top as the summit. The
    rest is the body: the two rows at least 60% of its height apart where the lower one best
    continues into the upper are found (step 2's cut, turned on its side), and below the body
    that stretch repeats until the wall is tall enough. Nothing is redrawn and no colour is new.
    """
    a = load(src)
    on = a[:, :, 3] > 0
    rows, cols = np.nonzero(on.any(1))[0], np.nonzero(on.any(0))[0]
    a = a[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]
    cap, height = int(cap), int(height)
    top, body = a[:cap], a[cap:]
    d, i, j = best_cut(np.ascontiguousarray(np.transpose(body, (1, 0, 2))), 0.6)
    loop = body[i:j]
    parts = [top, body[:j]]
    while sum(p.shape[0] for p in parts) < height:
        parts.append(loop)
    wall = np.concatenate(parts, 0)[:height]
    save(wall, out)
    seam = seam_ratio(np.ascontiguousarray(np.transpose(loop, (1, 0, 2))))
    print(f"{out}: {wall.shape[1]}x{height}, summit {cap} rows, body rows {i}..{j} repeat, seam ratio {seam[2]:.2f}")


def cmd_climb(out, spec):
    """A vertical preview: the camera climbs `climb` px (and pans `travel` px), eased, and back.

    `spec` is a JSON file:
      {"view": [256, 256], "sky": ["#top", ..., "#horizon"], "sky_speed": 0.05, "stars": 40,
       "climb": 320, "travel": 0, "frames": 120, "seed": 7,
       "layers": [
         {"image": "far.png", "bottom": 150, "speed": 0.125, "extend": true},
         {"image": "wall.png", "x": 0, "repeat": false, "repeat_y": true, "speed": 1.0},
         {"scatter": ["cloud.png", ...], "top": -300, "bottom": -60, "count": 6, "speed": 0.5},
         {"run": ["a.png", ...], "foot": 170, "speed": 0.25},
         {"fill": "#040920", "top": 206, "speed": 1.0}
       ]}
    Rows are view rows at rest: 0 is the top of the view, negative is above it. Each layer has
    `speed` and optionally its own `speed_y` (default `speed`). A layer gets ceil(climb x
    speed_y) rows of headroom above the view, which is how tall it must be drawn. `extend`
    repeats a layer's bottom row down to the canvas foot (true) or that many rows. The sky's
    bands spread over its whole height, so a climb at `sky_speed_y` passes through them; `stars` scatters
    single pixels of the top band's lightest neighbour over its top third. The camera is
    rounded to whole pixels first and each layer offset is floor(camera x speed). With STILL
    set, frames at the bottom, middle and top of the climb are written side by side.
    """
    import json

    cfg = json.load(open(spec))
    base = os.path.dirname(os.path.abspath(spec))
    vw, vh = cfg["view"]
    rng = np.random.default_rng(cfg.get("seed", 7))
    climb, travel = cfg.get("climb", 240), cfg.get("travel", 0)

    def path(p):
        return p if os.path.isabs(p) else os.path.join(base, p)

    def blank(sx, sy):
        head = int(np.ceil(climb * sy)) + 2
        return np.zeros((head + vh + 2, vw + int(np.ceil(travel * sx)) + 64, 4), np.int16), head

    def stamp(canvas, s, x, y):
        sh, sw = s.shape[:2]
        H, W = canvas.shape[:2]
        ys, xs = np.arange(sh) + y, np.arange(sw) + x
        oy, ox = (ys >= 0) & (ys < H), (xs >= 0) & (xs < W)
        if not oy.any() or not ox.any():
            return
        sub = s[np.ix_(oy, ox)]
        m = sub[:, :, 3] > 0
        region = canvas[ys[oy][0] : ys[oy][-1] + 1, xs[ox][0] : xs[ox][-1] + 1]
        region[m] = sub[m]

    layers = []
    sky_speed = cfg.get("sky_speed", 0.05)
    sky_speed_y = cfg.get("sky_speed_y", sky_speed)
    sky, sky_head = blank(travel and sky_speed, sky_speed_y)
    sky[:] = sky_array(sky.shape[1], sky.shape[0], cfg["sky"])
    if cfg.get("stars"):
        top = hexrgb(cfg["sky"][0])
        pal = [hexrgb(c) for c in cfg["sky"]]
        light = max(pal[1:], key=lambda c: int(c.sum())) if len(pal) > 1 else top
        third = sky.shape[0] // 3
        for _ in range(cfg["stars"]):
            sky[int(rng.integers(third)), int(rng.integers(sky.shape[1])), :3] = light
    layers.append((sky, sky_head, sky_speed, sky_speed_y))

    for L in cfg["layers"]:
        sx = L["speed"]
        sy = L.get("speed_y", sx)
        canvas, head = blank(sx, sy)
        H, W = canvas.shape[:2]
        if "image" in L:
            img = load(path(L["image"]))
            ih, iw = img.shape[:2]
            xs = range(-int(rng.integers(iw)) if L.get("offset") else 0, W, iw) if L.get("repeat", True) else [L.get("x", 0)]
            if L.get("repeat_y"):
                bottom = L.get("bottom", vh) + head
                ys = range(bottom - ih, L.get("top", -head) + head - ih, -ih)
            else:
                ys = [L["bottom"] - ih + head]
            for y in ys:
                for x in xs:
                    stamp(canvas, img, x, y)
            if L.get("extend") and not L.get("repeat_y"):
                b = min(L["bottom"] + head, H)
                stop = H if L["extend"] is True else min(H, b + int(L["extend"]))
                row = canvas[b - 1].copy()
                canvas[b:stop] = np.where(row[None, :, 3:] > 0, row[None], canvas[b:stop])
        elif "scatter" in L:
            sprites = [load(path(p)) for p in L["scatter"]]
            n, last = L.get("count", 6), -1
            band = (L["bottom"] - L["top"]) / n
            for k in range(n):
                pick = int(rng.integers(len(sprites)))
                if len(sprites) > 1 and pick == last:
                    pick = (pick + 1) % len(sprites)
                last = pick
                s = sprites[pick][:, ::-1] if rng.random() < 0.5 else sprites[pick]
                # One sprite per horizontal band, so they spread up the climb instead of clumping.
                y = int(L["top"] + band * k + rng.uniform(0, max(1, band - s.shape[0] / 2))) + head
                x = int(rng.uniform(-s.shape[1] / 3, W - s.shape[1] * 2 / 3))
                stamp(canvas, s, x, y)
        elif "run" in L:
            sprites = [load(path(p)) for p in L["run"]]
            x, last = -int(rng.uniform(0, 32)), -1
            while x < W:
                pick = int(rng.integers(len(sprites)))
                if len(sprites) > 1 and pick == last:
                    pick = (pick + 1) % len(sprites)
                last = pick
                s = sprites[pick][:, ::-1] if rng.random() < 0.5 else sprites[pick]
                j = L.get("jitter", 0)
                stamp(canvas, s, x, L["foot"] - s.shape[0] + int(rng.integers(-j, j + 1)) + head)
                x += int(s.shape[1] * L.get("step", 0.72) + rng.uniform(0, L.get("gap", 16)))
        elif "fill" in L:
            y0 = L.get("top", -head) + head
            y1 = min(H, L.get("bottom", H - head) + head)
            canvas[y0:y1, :, :3] = hexrgb(L["fill"])
            canvas[y0:y1, :, 3] = 255
        layers.append((canvas, head, sx, sy))

    frames = []
    n = cfg.get("frames", 120)
    for i in range(n):
        e = (1 - np.cos(2 * np.pi * i / n)) / 2
        cy, cx = int(round(e * climb)), int(round(e * travel))
        frame = np.zeros((vh, vw, 3), np.int16)
        for canvas, head, sx, sy in layers:
            oy, ox = int(np.floor(cy * sy)), int(np.floor(cx * sx))
            part = canvas[head - oy : head - oy + vh, ox : ox + vw]
            m = part[:, :, 3] > 0
            frame[m] = part[:, :, :3][m]
        frames.append(frame)
    write_gif(frames, out)
    still = os.environ.get("STILL")
    if still:
        picks = [frames[0], frames[n // 4], frames[n // 2]]
        strip = np.zeros((vh, vw * 3 + 8, 4), np.int16)
        strip[:, :, :3] = 255
        strip[:, :, 3] = 255
        for k, f in enumerate(picks):
            strip[:, k * (vw + 4) : k * (vw + 4) + vw, :3] = f
        save(strip, still, int(os.environ.get("SCALE", "1")))
    heads = {round(sy, 3): int(np.ceil(climb * sy)) for _, _, _, sy in layers}
    print(f"{out}: {n} frames, {vw}x{vh}, climb {climb}px, travel {travel}px, headroom by speed_y {heads}")


def cmd_sheet(out, cols, bg, paths):
    """Transparent pictures on one background colour in a grid, 6 px apart, enlarged twice.

    Each picture is trimmed to its opaque box and sits on the bottom of its cell, 6 px clear
    of every edge.
    """
    ims = []
    for p in paths:
        a = load(p)
        on = a[:, :, 3] > 0
        rows, cols_on = np.nonzero(on.any(1))[0], np.nonzero(on.any(0))[0]
        a = a[rows[0] : rows[-1] + 1, cols_on[0] : cols_on[-1] + 1]
        pad = np.zeros((a.shape[0] + 12, a.shape[1] + 12, 4), np.int16)
        pad[6:-6, 6:-6] = a
        ims.append(pad)
    cols = int(cols)
    w = max(a.shape[1] for a in ims)
    h = max(a.shape[0] for a in ims)
    rows = (len(ims) + cols - 1) // cols
    sheet = np.zeros((rows * (h + 6) - 6, cols * (w + 6) - 6, 4), np.int16)
    sheet[:, :, :3] = hexrgb(bg)
    sheet[:, :, 3] = 255
    for i, a in enumerate(ims):
        y = (i // cols) * (h + 6) + h - a.shape[0]
        x = (i % cols) * (w + 6) + (w - a.shape[1]) // 2
        m = a[:, :, 3] > 0
        sheet[y : y + a.shape[0], x : x + a.shape[1]][m] = a[m]
    save(sheet, out, 2)
    print(f"{out}: {len(ims)} pictures, {cols} a row")


def main():
    cmd, *args = sys.argv[1:]
    {
        "seam": lambda: cmd_seam(args),
        "loop": lambda: cmd_loop(*args),
        "split": lambda: cmd_split(args[0], args[1], int(args[2]), *(args[3:4])),
        "cut": lambda: cmd_cut(args[0], args[1], int(args[2]), *args[3:]),
        "preview": lambda: cmd_preview(args[0], args[1], args[2:]),
        "line": lambda: cmd_line(*args),
        "jitter": cmd_jitter,
        "scroll": lambda: cmd_scroll(args[0], args[1], args[2], args[3:]),
        "haze": lambda: cmd_haze(*args),
        "bands": lambda: cmd_bands(*args),
        "compose": lambda: cmd_compose(args[0], args[1], args[2], args[3:]),
        "screen": lambda: cmd_screen(args),
        "foot": lambda: cmd_foot(*args),
        "tint": lambda: cmd_tint(*args),
        "sky": lambda: cmd_sky(*args),
        "skyline": lambda: cmd_skyline(*args),
        "climb": lambda: cmd_climb(*args),
        "wall": lambda: cmd_wall(*args),
        "sheet": lambda: cmd_sheet(args[0], args[1], args[2], args[3:]),
    }[cmd]()


if __name__ == "__main__":
    main()
