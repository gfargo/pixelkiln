"""Draw the benchmark's OpenPose control images, one PNG per frame.

The maps are the varying input of a `frames` asset, so they are committed and
reviewed like art; this script only makes the first draft reproducible. Edit a
pose here (or the PNG by hand) when a limb is wrong, then re-run.

Format: the 18-keypoint COCO body of OpenPose, drawn the way the ControlNet
preprocessors draw it (`controlnet_aux`): limbs as filled ellipses in the
standard per-limb colours at 60% over black, joints as full-colour dots. No
face or hand keypoints. The figure is seen from the side, facing right, on a
1024x1024 canvas with its feet on one ground line, so scale and camera stay
fixed across every frame and every motion.

  python3 make-poses.py            # writes idle/, walk/, attack/ and sheet.png
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 1024
GROUND = 900          # y of the soles
HIP_X = 512           # the figure's hips stay over this column unless a pose moves them
STICK = 9             # half the limb thickness; controlnet_aux uses 4 at 512px

# Segment lengths in px for a figure about 680px tall (a squat, game-sprite build).
THIGH, SHIN = 170, 165
TORSO, NECK_HEAD = 200, 70
UPPER_ARM, FOREARM = 120, 110
SHOULDER_W = 26       # how far the far shoulder sits behind the near one, seen from the side

COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0),
    (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85),
]
# OpenPose limb pairs, 0-based: neck-shoulders, arms, neck-hips, legs, neck-nose, face.
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
         (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]


def polar(origin, length, degrees):
    """A point `length` from `origin` at `degrees` (0 = straight down, positive = toward the facing)."""
    a = math.radians(degrees)
    return (origin[0] + length * math.sin(a), origin[1] + length * math.cos(a))


def knee_for(hip, ankle, upper, lower):
    """Two-bone IK: the knee that joins `hip` to `ankle`, bending forward (toward +x)."""
    d = min(math.dist(hip, ankle), upper + lower - 1)
    base = math.atan2(ankle[1] - hip[1], ankle[0] - hip[0])
    spread = math.acos((upper * upper + d * d - lower * lower) / (2 * upper * d))
    options = [(hip[0] + upper * math.cos(base + s), hip[1] + upper * math.sin(base + s)) for s in (spread, -spread)]
    return max(options, key=lambda k: k[0])


def body(*, lean=0.0, crouch=12.0, near_foot=(18, 0), far_foot=(-18, 0), near_arm=(0, 0), far_arm=(0, 0),
         head_tilt=0.0, hip_shift=0.0, hip_lift=0.0):
    """Keypoints for one side-view pose.

    A foot is (x offset from the hips, height above the ground); the knees are solved
    from it, so a planted foot stays on the ground line. `crouch` lowers the hips below
    a straight leg. An arm is (upper angle, elbow bend) in degrees, 0 = hanging down,
    positive = toward the facing.

    The near side is the figure's left (it faces right, so the viewer sees its left);
    OpenPose colours left and right limbs differently, so the near side stays left in
    every frame and the model can tell the legs apart through a walk.
    """
    leg = THIGH + SHIN
    planted = [f for f in (near_foot, far_foot) if f[1] == 0] or [near_foot]
    reach = max(abs(f[0]) for f in planted)
    hip_y = GROUND - math.sqrt(max(1.0, (leg - crouch) ** 2 - reach ** 2)) - hip_lift
    hip = (HIP_X + hip_shift, hip_y)
    neck = polar(hip, TORSO, 180 + lean)
    nose = polar(neck, NECK_HEAD, 180 + lean + head_tilt - 20)
    eye = polar(neck, NECK_HEAD + 18, 180 + lean + head_tilt - 12)
    ear = polar(neck, NECK_HEAD - 8, 180 + lean + head_tilt + 12)

    def leg_points(base, foot):
        ankle = (base[0] + foot[0], GROUND - foot[1])
        return knee_for(base, ankle, THIGH, SHIN), ankle

    def arm(base, upper_angle, elbow_bend):
        elbow = polar(base, UPPER_ARM, upper_angle)
        wrist = polar(elbow, FOREARM, upper_angle + elbow_bend)
        return elbow, wrist

    near_hip = hip
    far_hip = (hip[0] - SHOULDER_W * 0.6, hip[1])
    near_sh = neck
    far_sh = (neck[0] - SHOULDER_W, neck[1])
    l_knee, l_ankle = leg_points(near_hip, near_foot)
    r_knee, r_ankle = leg_points(far_hip, far_foot)
    l_elb, l_wri = arm(near_sh, *near_arm)
    r_elb, r_wri = arm(far_sh, *far_arm)
    hidden = None  # the far eye and ear are behind the head
    return [nose, neck, far_sh, r_elb, r_wri, near_sh, l_elb, l_wri, far_hip, r_knee, r_ankle,
            near_hip, l_knee, l_ankle, hidden, eye, hidden, ear]


def draw(points):
    canvas = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    for i, (a, b) in enumerate(LIMBS):
        pa, pb = points[a], points[b]
        if pa is None or pb is None:
            continue
        layer = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
        d = ImageDraw.Draw(layer)
        length = math.dist(pa, pb)
        angle = math.atan2(pb[1] - pa[1], pb[0] - pa[0])
        mx, my = (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2
        poly = []
        for k in range(24):
            t = 2 * math.pi * k / 24
            ex, ey = length / 2 * math.cos(t), STICK * math.sin(t)
            poly.append((mx + ex * math.cos(angle) - ey * math.sin(angle), my + ex * math.sin(angle) + ey * math.cos(angle)))
        d.polygon(poly, fill=COLORS[i])
        canvas = Image.blend(canvas, Image.composite(layer, canvas, layer.convert("L").point(lambda v: 255 if v else 0)), 0.6)
    d = ImageDraw.Draw(canvas)
    for i, p in enumerate(points):
        if p is None:
            continue
        d.ellipse((p[0] - STICK, p[1] - STICK, p[0] + STICK, p[1] + STICK), fill=COLORS[i])
    return canvas


def idle(i, n=4):
    """A breath: the chest rises and falls, arms hang and sway a little, feet stay put."""
    s = math.sin(2 * math.pi * i / n)
    return body(crouch=14 + 4 * s, lean=1 * s, near_foot=(22, 0), far_foot=(-20, 0),
                near_arm=(10 + 3 * s, 20), far_arm=(-6 - 3 * s, 18), head_tilt=2 * s)


STRIDE, LIFT = 190, 55


# walk-wide/: the same cycle exaggerated, because SDXL's OpenPose ControlNet drew the
# walk above with the legs nearly together (runs 1-6). Longer stride, higher knee, more
# arm swing and lean, and a bob: the hips drop on contact and rise when passing.
WIDE_STRIDE, WIDE_LIFT, WIDE_ARM, WIDE_LEAN, WIDE_BOB = 330, 115, 55, 10, 30


def walk_foot(phase, stride=STRIDE, lift=LIFT):
    """A foot through one cycle: planted and sliding back under the body for the first
    half, then lifted and carried forward in an arc."""
    phase %= 1.0
    if phase < 0.5:
        return (stride / 2 - stride * phase / 0.5, 0)
    t = (phase - 0.5) / 0.5
    return (-stride / 2 + stride * t, lift * math.sin(math.pi * t))


def walk(i, n=8):
    """A walk cycle in eight: contact, down, passing, up, then the same on the other leg."""
    phase = i / n
    t = 2 * math.pi * phase
    return body(lean=4, crouch=10, near_foot=walk_foot(phase), far_foot=walk_foot(phase + 0.5),
                near_arm=(-26 * math.cos(t), 25), far_arm=(26 * math.cos(t), 25))


def walk_wide(i, n=8):
    """The walk above, exaggerated (see WIDE_*)."""
    phase = i / n
    t = 2 * math.pi * phase
    return body(lean=WIDE_LEAN, crouch=10 + WIDE_BOB * (1 + math.cos(2 * t)) / 2,
                near_foot=walk_foot(phase, WIDE_STRIDE, WIDE_LIFT), far_foot=walk_foot(phase + 0.5, WIDE_STRIDE, WIDE_LIFT),
                near_arm=(-WIDE_ARM * math.cos(t), 30), far_arm=(WIDE_ARM * math.cos(t), 30))


def attack(i):
    """A one-handed strike in four: wind-up, strike, follow-through, recover."""
    poses = [
        # wind-up: weight on the back foot, near arm raised behind the head
        dict(lean=-8, crouch=30, near_foot=(70, 0), far_foot=(-80, 0), near_arm=(-150, -40), far_arm=(30, 40), hip_shift=-20),
        # strike: lunge onto the front foot, arm sweeping down in front
        dict(lean=16, crouch=60, near_foot=(110, 0), far_foot=(-120, 0), near_arm=(80, 10), far_arm=(-30, 30), hip_shift=20),
        # follow-through: arm low across the body, weight still forward
        dict(lean=20, crouch=64, near_foot=(105, 0), far_foot=(-125, 0), near_arm=(20, 10), far_arm=(-40, 30), hip_shift=25),
        # recover: back to a guard, weight centred
        dict(lean=4, crouch=26, near_foot=(70, 0), far_foot=(-70, 0), near_arm=(40, 70), far_arm=(-10, 40), hip_shift=5),
    ]
    return body(**poses[i])


def attack_wide(i):
    """The strike above, exaggerated like walk-wide: the sword arm straight up behind the head
    on the wind-up and straight out in front on the strike, a longer lunge, and
    more lean, because the ControlNet draws less motion than the map shows (run 8)."""
    poses = [
        dict(lean=-18, crouch=40, near_foot=(90, 0), far_foot=(-120, 0), near_arm=(-150, -40), far_arm=(40, 40), hip_shift=-40),
        dict(lean=26, crouch=55, near_foot=(150, 0), far_foot=(-150, 0), near_arm=(95, 0), far_arm=(-50, 20), hip_shift=45),
        dict(lean=32, crouch=60, near_foot=(145, 0), far_foot=(-155, 0), near_arm=(-25, 10), far_arm=(-60, 20), hip_shift=50),
        dict(lean=2, crouch=30, near_foot=(80, 0), far_foot=(-80, 0), near_arm=(60, 80), far_arm=(-10, 40), hip_shift=5),
    ]
    return body(**poses[i])


# The weapon for attack-wide, as a second control image: white strokes on black for a scribble
# ControlNet, since the OpenPose map has no joint for a prop (run 9). One angle per frame, in
# polar() degrees from the near wrist: up and back, forward, down and back, up in guard.
PROP_ANGLES = [-160, 80, -40, 150]
PROPS = {"knight": "sword", "goblin": "club"}


def prop_image(points, angle, kind):
    canvas = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    d = ImageDraw.Draw(canvas)
    wrist = points[7]
    if kind == "sword":
        tip, pommel = polar(wrist, 220, angle), polar(wrist, -40, angle)
        d.line((pommel, tip), fill=(255, 255, 255), width=14)
        guard = polar(wrist, 18, angle)
        a, b = polar(guard, 40, angle + 90), polar(guard, 40, angle - 90)
        d.line((a, b), fill=(255, 255, 255), width=12)
    else:
        tip, butt = polar(wrist, 175, angle), polar(wrist, -30, angle)
        d.line((butt, tip), fill=(255, 255, 255), width=16)
        d.ellipse((tip[0] - 38, tip[1] - 38, tip[0] + 38, tip[1] + 38), outline=(255, 255, 255), width=12)
    return canvas


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    motions = {"idle": [idle(i) for i in range(4)], "walk": [walk(i) for i in range(8)], "attack": [attack(i) for i in range(4)],
               "walk-wide": [walk_wide(i) for i in range(8)], "attack-wide": [attack_wide(i) for i in range(4)]}
    rows = []
    for name, frames in motions.items():
        os.makedirs(os.path.join(here, name), exist_ok=True)
        images = []
        for i, points in enumerate(frames):
            image = draw(points)
            image.save(os.path.join(here, name, f"frame-{i:02d}.png"), optimize=True)
            images.append(image)
        rows.append(images)
    # A contact sheet at 1/4 scale, one motion per row, with the ground line marked.
    cell = SIZE // 4
    sheet = Image.new("RGB", (cell * 8, cell * len(rows)), (24, 24, 24))
    for r, images in enumerate(rows):
        for c, image in enumerate(images):
            sheet.paste(image.resize((cell, cell), Image.LANCZOS), (c * cell, r * cell))
        ImageDraw.Draw(sheet).line((0, r * cell + GROUND // 4, cell * 8, r * cell + GROUND // 4), fill=(80, 80, 80))
    sheet.save(os.path.join(here, "sheet.png"), optimize=True)
    for character, kind in PROPS.items():
        folder = os.path.join(here, f"attack-wide-prop-{character}")
        os.makedirs(folder, exist_ok=True)
        for i, angle in enumerate(PROP_ANGLES):
            prop_image(attack_wide(i), angle, kind).save(os.path.join(folder, f"frame-{i:02d}.png"), optimize=True)


if __name__ == "__main__":
    main()
