"""Parallax experiments on flattened pixel-art backgrounds.

Research script for docs/RESEARCH_PARALLAX.md. Rough, takes paths as arguments.

    python3 parallax.py seam <png>...                       how badly each image wraps
    python3 parallax.py loop <png> <out.png> <method>       make it wrap: cut, crossfade or mirror
    python3 parallax.py split <png> <out-dir> <bands> [depth.png]
                                                            cut into depth layers along skylines
    python3 parallax.py preview <out.gif> <f0,f1,...> <layer.png>...
                                                            pan a camera over layers
    python3 parallax.py line <png> <out.gif> <horizon-row>  per-row (raster) scroll of one image
    python3 parallax.py jitter                              rounding schemes, numbers only
    python3 parallax.py haze <png> <out.png> <t>            push an image toward its sky colour, palette held
    python3 parallax.py bands <png> <bands> [depth.png]     contrast and sky distance per depth band
    python3 parallax.py compose <out.gif> <sky,far,near> <seed> <sprite.png>...
                                                            layers built from separate silhouettes, camera pans up

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
    """Mean absolute RGB difference between two columns, 0-255."""
    return float(np.abs(a[:, :3].astype(int) - b[:, :3].astype(int)).mean())


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
            d = float(np.abs(cols[:, j - 1] - cols[:, i]).mean())
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


def write_gif(frames, out, scale=1, ms=33):
    imgs = []
    for f in frames:
        im = Image.fromarray(f.astype(np.uint8), "RGB")
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        imgs.append(im.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
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


def main():
    cmd, *args = sys.argv[1:]
    {
        "seam": lambda: cmd_seam(args),
        "loop": lambda: cmd_loop(*args),
        "split": lambda: cmd_split(args[0], args[1], int(args[2]), *(args[3:4])),
        "preview": lambda: cmd_preview(args[0], args[1], args[2:]),
        "line": lambda: cmd_line(*args),
        "jitter": cmd_jitter,
        "haze": lambda: cmd_haze(*args),
        "bands": lambda: cmd_bands(*args),
        "compose": lambda: cmd_compose(args[0], args[1], args[2], args[3:]),
    }[cmd]()


if __name__ == "__main__":
    main()
