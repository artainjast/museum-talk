"""Walk-cycle sprite sheets for the museum-tour characters.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/make_walk.py
  (optional: WALK_CHARS=dog,guide to render a subset)

Reuses the builders, camera and framing from make_sprites.py (same ortho scale and
anchor as the single sprites, which are NOT touched). Outputs
public/sprites/<name>_walk.png = 640x384, 5 cols x 3 rows of 128x128 cells:
  rows: 0 = facing camera (south), 1 = back (north), 2 = side facing screen-right (east)
  cols: 0 = idle, 1 = contact (left leg fwd), 2 = passing (+2px lift),
        3 = contact (right leg fwd), 4 = passing
and art/walk_contact.png (preview of a few sheets on a checker background).
Limbs are rigid boxes rotated about hip/shoulder pivots; views rotate the character.
"""
import math
import os
import shutil
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "make_sprites.py")

# Load make_sprites.py as a library (everything except its trailing main() call).
_src = open(SRC).read().rstrip()
assert _src.endswith("main()"), "make_sprites.py layout changed"
LIB = {"__name__": "make_sprites_lib", "__file__": SRC}
exec(compile(_src[: -len("main()")], SRC, "exec"), LIB)

RES = LIB["RES"]
OUT_DIR = LIB["OUT_DIR"]
ELEV = math.radians(LIB["ELEV_DEG"])
CONTACT = os.path.join(HERE, "walk_contact.png")
PREVIEW = ["dog", "guide", "penguin"]
LEG_DEG, ARM_DEG = 28.0, 28.0
LIFT_PX = 2.0
VIEWS = [0.0, 180.0, 90.0]  # rot about Z: front, back, side facing screen-right
# col -> which leg is forward (+1 = +x leg, -1 = -x leg, 0 = together), lifted?
COLS = [(0, False), (1, False), (0, True), (-1, False), (0, True)]


# ---------------------------------------------------------------- helpers
def mesh_objs(coll):
    return [o for o in coll.objects if o.type == "MESH"]


def bounds_cam(cam, objs):
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for ob in objs:
        mw = ob.matrix_world
        for v in ob.data.vertices:
            p = inv @ (mw @ v.co)
            xs.append(p.x)
            ys.append(p.y)
    return min(xs), max(xs), min(ys), max(ys)


def info(ob):
    vs = [v.co for v in ob.data.vertices]
    c = sum(vs, Vector()) / len(vs)
    return c, min(v.z for v in vs), max(v.z for v in vs)


def set_origin(ob, p):
    ob.data.transform(Matrix.Translation(-p))
    ob.location = p.copy()


class Rig:
    def __init__(self, b, is_guide):
        self.coll = b.coll
        self.objs = mesh_objs(b.coll)
        self.root = bpy.data.objects.new(b.coll.name + "_root", None)
        bpy.context.scene.collection.objects.link(self.root)
        legs, arms, prop = {1: [], -1: []}, {1: [], -1: []}, []
        arm_top = 1.5 if is_guide else 1.16
        for o in self.objs:
            c, z0, z1 = info(o)
            s = 1 if c.x > 0 else -1
            if is_guide and abs(c.x) >= 0.5 and c.z > 1.5:
                prop.append(o)
            elif c.z < 0.42 and abs(c.x) > 0.03:
                legs[s].append(o)
            elif abs(c.x) >= 0.4 and 0.5 < c.z < arm_top:
                arms[s].append(o)
        self.static_arm = 0
        self.prop, self.grip = prop, None
        if prop:
            pole = max(prop, key=lambda o: info(o)[2] - info(o)[1])
            pc = info(pole)[0]
            self.grip = Vector((pc.x, pc.y, 0.95))
            self.static_arm = 1 if pc.x > 0 else -1
            for o in prop:
                set_origin(o, self.grip)
        for group, drop in ((legs, 0.04), (arms, 0.07)):
            for s, objs in group.items():
                if not objs:
                    continue
                top = max(objs, key=lambda o: info(o)[2])
                c, _, z1 = info(top)
                piv = Vector((c.x, 0.0, z1 - drop))
                for o in objs:
                    set_origin(o, piv)
        self.legs, self.arms = legs, arms
        for o in self.objs:
            o.parent = self.root
        print(f"RIG {b.coll.name}: legs {len(legs[1])}/{len(legs[-1])} "
              f"arms {len(arms[1])}/{len(arms[-1])} prop {len(prop)}")

    def pose(self, fwd, lift_world, view_deg):
        self.root.location = (0, 0, 0)
        self.root.rotation_euler = (0, 0, math.radians(view_deg))
        for s in (1, -1):
            for o in self.legs[s]:
                o.rotation_euler.x = math.radians(-s * fwd * LEG_DEG)
            if s == self.static_arm:
                continue
            for o in self.arms[s]:
                o.rotation_euler.x = math.radians(s * fwd * ARM_DEG)
        bpy.context.view_layer.update()
        minz = min((o.matrix_world @ v.co).z for o in self.objs for v in o.data.vertices)
        self.root.location.z = -minz + lift_world  # lowest foot on the ground line
        bpy.context.view_layer.update()

    def set_prop(self, rot_deg=0.0, slide=0.0, scale=1.0):
        for o in self.prop:
            o.rotation_euler.z = math.radians(rot_deg)
            o.location = self.grip - Vector((0, 0, slide))
            o.scale = (scale, scale, scale)
        bpy.context.view_layer.update()


def load_px(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)


def save_png(arr, path):
    h, w, _ = arr.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    print("WROTE", path)


# ---------------------------------------------------------------- main
def main():
    sc, cam = LIB["setup_scene"]()
    chars = [fn() for fn in LIB["BUILDERS"]]
    bpy.context.view_layer.update()
    # identical framing to make_sprites.main()
    bounds = {b.coll.name: LIB["cam_bounds"](cam, b.coll) for b in chars}
    span = 0.0
    ymin = min(bd[2] for bd in bounds.values())
    for x0, x1, y0, y1 in bounds.values():
        span = max(span, 2 * max(abs(x0), abs(x1)), y1 - ymin)
    margin = 0.04
    S = span / (1 - 2 * margin)
    cam.data.ortho_scale = S
    cam.data.shift_x = 0.0
    cam.data.shift_y = (ymin - margin * S + S / 2) / S
    px_w = S / RES
    lift_world = LIFT_PX * px_w / math.cos(ELEV)
    top_lim = cam.data.shift_y * S + S / 2 - 2 * px_w
    half_w = S / 2 - 2 * px_w
    print(f"ORTHO_SCALE {S:.3f} SHIFT_Y {cam.data.shift_y:.3f} LIFT {lift_world:.4f}")

    rigs = {b.coll.name: Rig(b, b.coll.name == "guide") for b in chars}
    all_colls = [b.coll for b in chars]

    only = [s for s in os.environ.get("WALK_CHARS", "").split(",") if s]
    names = [b.coll.name for b in chars if not only or b.coll.name in only]
    tmp = tempfile.mkdtemp(prefix="walk_")
    sheets = {}
    try:
        for name in names:
            sheet = np.zeros((3 * RES, 5 * RES, 4), dtype=np.float32)
            for row, view in enumerate(VIEWS):
                rig = rigs[name]
                for c in all_colls:
                    c.hide_render = c is not rig.coll
                if rig.prop:
                    # flag trails behind the walker in side view; fit the prop in frame
                    rot = 90.0 * rig.static_arm if row == 2 else 0.0
                    rig.set_prop(rot)
                    if row != 0:
                        rig.pose(0, lift_world, view)  # highest pose of the cycle
                        slide, scale = 0.0, 1.0
                        excess = bounds_cam(cam, rig.objs)[3] - top_lim
                        if excess > 0:
                            # back view: slide the pole down through the hand; side view:
                            # keep the (trailing) flag above the head and shrink instead
                            if row == 1:
                                slide = min(excess / math.cos(ELEV) + 0.01, 0.35)
                                rig.set_prop(rot, slide)
                            while bounds_cam(cam, rig.objs)[3] > top_lim and scale > 0.5:
                                scale -= 0.02
                                rig.set_prop(rot, slide, scale)
                        print(f"PROP {name} row{row}: slide {slide:.2f} scale {scale:.2f}")
                for col, (fwd, lifted) in enumerate(COLS):
                    rig.pose(fwd, lift_world if lifted else 0.0, view)
                    x0, x1, y0, y1 = bounds_cam(cam, rig.objs)
                    if y1 > top_lim or max(-x0, x1) > half_w:
                        print(f"WARN crop risk {name} r{row}c{col}: x[{x0:.2f},{x1:.2f}] "
                              f"top {y1:.2f} > {top_lim:.2f}?")
                    p = os.path.join(tmp, f"{name}_{row}_{col}.png")
                    sc.render.filepath = p
                    bpy.ops.render.render(write_still=True)
                    y0p = (2 - row) * RES  # blender rows start at the bottom
                    sheet[y0p:y0p + RES, col * RES:(col + 1) * RES] = load_px(p)
            save_png(sheet, os.path.join(OUT_DIR, f"{name}_walk.png"))
            sheets[name] = sheet
            report(name, sheet)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    contact(sheets)


def report(name, sheet):
    a = sheet[..., 3][::-1]  # top-down rows
    feet, edge = [], 0.0
    for r in range(3):
        for c in range(5):
            cell = a[r * RES:(r + 1) * RES, c * RES:(c + 1) * RES]
            rows = np.where(cell.max(1) > 0.5)[0]
            feet.append(int(rows.max()) if len(rows) else -1)
            edge = max(edge, cell[0].max(), cell[-1].max(), cell[:, 0].max(), cell[:, -1].max())
    base = os.path.join(OUT_DIR, name + ".png")
    diff = -1.0
    if os.path.exists(base):
        ref = load_px(base)
        idle = sheet[2 * RES:3 * RES, 0:RES]
        diff = float(np.abs(ref - idle).max())
    print(f"CHECK {name}: feet rows {feet} edge_alpha {edge:.2f} idle_vs_single {diff:.3f}")


def contact(sheets):
    picks = [n for n in PREVIEW if n in sheets] or list(sheets)[:3]
    if not picks:
        return
    H, W = 3 * RES * len(picks), 5 * RES
    yy, xx = np.mgrid[0:H, 0:W]
    bg = 0.78 + 0.08 * (((yy // 16) + (xx // 16)) % 2).astype(np.float32)
    out = np.ones((H, W, 4), dtype=np.float32)
    out[..., :3] = bg[..., None]
    for i, n in enumerate(picks):
        y0 = (len(picks) - 1 - i) * 3 * RES
        s = sheets[n]
        a = s[..., 3:4]
        out[y0:y0 + 3 * RES, :, :3] = s[..., :3] * a + out[y0:y0 + 3 * RES, :, :3] * (1 - a)
    # faint cell grid
    for k in range(0, W, RES):
        out[:, k, :3] *= 0.85
    for k in range(0, H, RES):
        out[k, :, :3] *= 0.85
    save_png(out, CONTACT)


main()
