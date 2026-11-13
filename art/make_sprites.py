"""Procedural blocky-voxel character sprites for the museum-tour game.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/make_sprites.py

Outputs public/sprites/<name>.png (128x128 RGBA, transparent) and art/contact.png.
All designs are original: chibi block humanoids with animal heads + a tour guide.
Shading is baked into an emission shader from the face normal (top light, sides
darker), so colors are exact and no lights are needed. Optional Freestyle outline.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "public", "sprites")
CONTACT = os.path.join(HERE, "contact.png")
RES = 128
OUTLINE = os.environ.get("SPRITE_OUTLINE", "1") == "1"
ELEV_DEG = 40.0  # camera elevation above horizontal

os.makedirs(OUT_DIR, exist_ok=True)


# ---------------------------------------------------------------- helpers
def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip("#")
    return tuple(srgb_to_lin(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)


_MATS = {}


def mat_for(hexcol):
    if hexcol in _MATS:
        return _MATS[hexcol]
    m = bpy.data.materials.new("m_" + hexcol.lstrip("#"))
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    # shade = 0.62 + N . k  -> top 1.0, front 0.78, left 0.72, right 0.52
    dot.inputs[1].default_value = (-0.10, -0.16, 0.38)
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    add.inputs[1].default_value = 0.62
    emi = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    normal_out = next(o for o in geo.outputs if o.identifier == "Normal")
    nt.links.new(normal_out, dot.inputs[0])
    dot_val = next(o for o in dot.outputs if o.identifier == "Value")
    nt.links.new(dot_val, add.inputs[0])
    nt.links.new(add.outputs[0], emi.inputs[1])  # Strength
    emi.inputs[0].default_value = hex_lin(hexcol)  # Color
    nt.links.new(emi.outputs[0], out.inputs[0])
    m.diffuse_color = hex_lin(hexcol)
    _MATS[hexcol] = m
    return m


FACES = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


class Builder:
    def __init__(self, name):
        self.coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(self.coll)
        self.n = 0

    def box(self, center, size, color):
        cx, cy, cz = center
        hx, hy, hz = (s / 2.0 for s in size)
        verts = [(cx + dx * hx, cy + dy * hy, cz + dz * hz)
                 for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
        me = bpy.data.meshes.new(f"{self.coll.name}_{self.n}")
        me.from_pydata(verts, [], FACES)
        me.materials.append(mat_for(color))
        ob = bpy.data.objects.new(me.name, me)
        self.coll.objects.link(ob)
        self.n += 1
        return ob

    def face(self, x, z, w, h, color, protrude=0.0, depth=0.06, front=-0.45):
        """Flat plate on the head's front face (front plane y=front)."""
        self.box((x, front - depth / 2 + 0.01 - protrude, z), (w, depth, h), color)


# ---------------------------------------------------------------- palette
BLACK = "#1b1b1f"
WHITE = "#f7f5f0"
PANTS = "#3b4456"
SHOE = "#22252b"
PINK = "#f4a3b4"


def visitor_body(b, fur, shirt, pants=PANTS, shoe=SHOE, hand=None, eyes=True,
                 eye_z=1.62, head=True):
    hand = hand or fur
    for s in (-1, 1):
        b.box((s * 0.16, 0, 0.25), (0.27, 0.32, 0.4), pants)
        b.box((s * 0.16, -0.03, 0.05), (0.29, 0.38, 0.1), shoe)
        b.box((s * 0.47, 0, 0.93), (0.22, 0.26, 0.34), shirt)  # sleeve
        b.box((s * 0.47, 0, 0.635), (0.2, 0.24, 0.25), hand)  # hand
    b.box((0, 0, 0.775), (0.72, 0.42, 0.65), shirt)
    if head:
        b.box((0, 0, 1.55), (1.0, 0.9, 0.9), fur)
    if eyes:
        for s in (-1, 1):
            b.face(s * 0.22, eye_z, 0.13, 0.17, BLACK, protrude=0.02)


# ---------------------------------------------------------------- characters
def make_cat():
    b = Builder("cat")
    fur, dark = "#8d96a3", "#545c69"
    visitor_body(b, fur, "#7e57c2")
    for s in (-1, 1):
        b.box((s * 0.3, 0.05, 2.09), (0.28, 0.18, 0.2), fur)
        b.box((s * 0.33, 0.05, 2.24), (0.14, 0.13, 0.14), fur)
        b.box((s * 0.3, -0.04, 2.09), (0.13, 0.04, 0.13), PINK)
        for z in (1.35, 1.44):  # whiskers
            b.box((s * 0.5, -0.52, z), (0.34, 0.03, 0.035), "#2b2b30")
    b.face(0, 1.38, 0.38, 0.2, WHITE, protrude=0.03)
    b.face(0, 1.47, 0.13, 0.08, "#e86f8c", protrude=0.07)
    for x in (-0.18, 0.0, 0.18):  # tabby stripes over the top
        b.box((x, 0.0, 2.005), (0.08, 0.6, 0.03), dark)
        b.face(x, 1.86, 0.07, 0.16, dark, protrude=0.0)
    return b


def make_dog():
    b = Builder("dog")
    fur, brown = "#f0dfc0", "#8b5a2b"
    visitor_body(b, fur, "#3f7fd1", eyes=False)
    for s in (-1, 1):
        b.box((s * 0.52, 0.0, 1.97), (0.28, 0.42, 0.12), brown)
        b.box((s * 0.6, 0.0, 1.6), (0.16, 0.38, 0.66), brown)  # floppy ear
    b.face(-0.22, 1.63, 0.3, 0.32, brown, protrude=0.0)  # eye patch
    for s in (-1, 1):
        b.face(s * 0.22, 1.62, 0.13, 0.17, BLACK, protrude=0.04)
    b.box((0, -0.53, 1.36), (0.42, 0.2, 0.28), "#fff4e0")  # snout
    b.box((0, -0.64, 1.47), (0.18, 0.06, 0.1), BLACK)  # nose
    b.box((0, -0.64, 1.27), (0.12, 0.04, 0.08), "#e0566e")  # tongue
    return b


def make_fox():
    b = Builder("fox")
    fur = "#e8772e"
    visitor_body(b, fur, "#26a69a", eye_z=1.66)
    for s in (-1, 1):
        b.box((s * 0.3, 0.05, 2.1), (0.3, 0.18, 0.22), fur)
        b.box((s * 0.32, 0.05, 2.28), (0.2, 0.15, 0.16), fur)
        b.box((s * 0.33, 0.05, 2.41), (0.11, 0.13, 0.12), BLACK)
        b.box((s * 0.3, -0.04, 2.13), (0.13, 0.04, 0.15), "#3a2a20")
        b.box((s * 0.53, -0.12, 1.3), (0.1, 0.36, 0.22), WHITE)  # cheek tufts
    b.face(0, 1.33, 1.0, 0.4, WHITE, protrude=0.0)
    b.box((0, -0.55, 1.36), (0.34, 0.22, 0.24), WHITE)  # snout
    b.box((0, -0.67, 1.44), (0.13, 0.06, 0.1), BLACK)
    b.box((0, -0.22, 0.85), (0.34, 0.04, 0.4), WHITE)  # chest fluff
    return b


def make_panda():
    b = Builder("panda")
    fur, blk = "#f4f4f2", "#1e1e22"
    visitor_body(b, fur, "#e04b3c", pants=blk, hand=blk, eyes=False)
    for s in (-1, 1):
        b.box((s * 0.36, 0.08, 2.08), (0.28, 0.2, 0.24), blk)
        b.face(s * 0.22, 1.6, 0.28, 0.32, blk, protrude=0.0)
        b.face(s * 0.2, 1.65, 0.08, 0.09, WHITE, protrude=0.03)
    b.face(0, 1.38, 0.36, 0.2, "#ffffff", protrude=0.02)
    b.face(0, 1.44, 0.16, 0.09, blk, protrude=0.05)
    return b


def make_frog():
    b = Builder("frog")
    fur, belly = "#5dbb46", "#b8e07a"
    visitor_body(b, fur, "#d6579a", eyes=False, head=False)
    b.box((0, 0, 1.5), (1.06, 0.92, 0.8), fur)  # flatter head (1.1..1.9)
    for s in (-1, 1):
        b.box((s * 0.28, -0.1, 2.0), (0.34, 0.34, 0.26), fur)  # eye bulbs
        b.box((s * 0.28, -0.28, 2.02), (0.24, 0.04, 0.2), WHITE)
        b.box((s * 0.28, -0.305, 2.02), (0.11, 0.04, 0.13), BLACK)
        b.face(s * 0.38, 1.5, 0.14, 0.08, "#f48fb1", protrude=0.0, front=-0.46)
        b.face(s * 0.08, 1.62, 0.05, 0.05, "#2f5e24", protrude=0.0, front=-0.46)
    b.face(0, 1.38, 0.66, 0.05, "#7a1f2b", protrude=0.0, front=-0.46)
    b.face(0, 1.24, 0.6, 0.18, belly, protrude=0.0, front=-0.46)
    return b


def make_monkey():
    b = Builder("monkey")
    fur, tan = "#7b4a2a", "#e9c49a"
    visitor_body(b, fur, "#7cb342", eyes=False)
    b.face(0, 1.42, 0.74, 0.5, tan, protrude=0.0)
    for s in (-1, 1):
        b.face(s * 0.19, 1.71, 0.32, 0.26, tan, protrude=0.0)
        b.face(s * 0.19, 1.68, 0.12, 0.16, BLACK, protrude=0.02)
        b.box((s * 0.57, 0, 1.6), (0.16, 0.18, 0.3), fur)  # side ears
        b.box((s * 0.6, -0.1, 1.6), (0.1, 0.04, 0.2), tan)
    b.box((0, -0.53, 1.32), (0.46, 0.16, 0.26), "#f2d3ae")  # muzzle
    for s in (-1, 1):
        b.box((s * 0.07, -0.615, 1.39), (0.05, 0.03, 0.05), "#4a2a18")
    b.box((0, -0.615, 1.27), (0.24, 0.03, 0.04), "#4a2a18")
    b.box((0, -0.05, 2.04), (0.22, 0.24, 0.12), fur)  # tuft
    return b


def make_lion():
    b = Builder("lion")
    face, mane, mane2 = "#e8b04f", "#a0521d", "#86421a"
    visitor_body(b, face, "#4fa3e0")
    b.box((0, 0.3, 1.6), (1.44, 0.4, 1.3), mane)  # back of mane
    for s in (-1, 1):
        b.box((s * 0.62, -0.06, 1.58), (0.24, 0.76, 1.12), mane)
        b.box((s * 0.62, -0.06, 1.58), (0.18, 0.8, 0.4), mane2)
        b.box((s * 0.36, -0.2, 2.27), (0.2, 0.14, 0.14), mane2)  # ears
    b.box((0, -0.06, 2.12), (1.48, 0.78, 0.26), mane)
    b.box((0, -0.06, 2.12), (0.5, 0.82, 0.2), mane2)
    b.box((0, -0.3, 1.1), (1.0, 0.36, 0.16), mane)  # chin ruff
    b.box((0, -0.53, 1.36), (0.46, 0.18, 0.28), "#f7e0b0")
    b.box((0, -0.63, 1.46), (0.18, 0.06, 0.1), "#5a2e1a")
    return b


def make_tiger():
    b = Builder("tiger")
    fur, blk = "#f28c28", "#1e1a18"
    visitor_body(b, fur, "#2e7d32")
    for s in (-1, 1):
        b.box((s * 0.34, 0.05, 2.08), (0.26, 0.16, 0.2), fur)
        b.box((s * 0.34, -0.04, 2.08), (0.13, 0.04, 0.11), WHITE)
        b.face(s * 0.22, 1.79, 0.2, 0.07, WHITE, protrude=0.0)  # brows
        for z in (1.52, 1.38):  # cheek stripes
            b.face(s * 0.42, z, 0.16, 0.06, blk, protrude=0.0)
        for z in (1.78, 1.58, 1.38):  # side stripes
            b.box((s * 0.505, 0.02, z), (0.03, 0.5, 0.07), blk)
    for y in (-0.28, -0.05, 0.18):  # top stripes
        b.box((0, y, 2.005), (0.76, 0.08, 0.03), blk)
    b.face(0, 1.9, 0.08, 0.14, blk, protrude=0.0)
    for s in (-1, 1):
        b.face(s * 0.13, 1.89, 0.06, 0.1, blk, protrude=0.0)
    b.box((0, -0.52, 1.35), (0.46, 0.16, 0.26), WHITE)
    b.box((0, -0.61, 1.44), (0.16, 0.06, 0.09), "#d0566a")
    for s in (-1, 1):  # arm stripes
        b.box((s * 0.47, -0.125, 0.66), (0.2, 0.02, 0.05), blk)
    return b


def make_koala():
    b = Builder("koala")
    fur, fluff = "#a59f98", "#f3efea"
    visitor_body(b, fur, "#e76f51", eye_z=1.6)
    for s in (-1, 1):
        b.box((s * 0.6, 0.02, 1.92), (0.42, 0.22, 0.44), fur)
        b.box((s * 0.6, -0.1, 1.9), (0.28, 0.04, 0.28), fluff)
    b.box((0, -0.5, 1.42), (0.26, 0.12, 0.34), "#2a2a2a")  # big nose
    b.face(0, 1.2, 0.36, 0.12, fluff, protrude=0.0)
    return b


def make_penguin():
    b = Builder("penguin")
    blk, orange = "#1f2430", "#f5a623"
    for s in (-1, 1):
        b.box((s * 0.16, 0, 0.25), (0.27, 0.32, 0.4), blk)
        b.box((s * 0.16, -0.05, 0.05), (0.3, 0.44, 0.1), orange)
        b.box((s * 0.46, 0.0, 0.82), (0.16, 0.3, 0.6), blk)  # flippers
    b.box((0, 0, 0.775), (0.72, 0.42, 0.65), blk)
    b.box((0, -0.22, 0.74), (0.5, 0.04, 0.56), WHITE)  # belly
    b.box((0, -0.235, 1.04), (0.24, 0.04, 0.1), "#d63a3a")  # bow tie
    b.box((0, 0, 1.55), (1.0, 0.9, 0.9), blk)
    b.face(0, 1.47, 0.78, 0.6, WHITE, protrude=0.0)
    for s in (-1, 1):
        b.face(s * 0.22, 1.62, 0.13, 0.17, BLACK, protrude=0.02)
    b.box((0, -0.57, 1.43), (0.28, 0.2, 0.14), orange)
    b.box((0, -0.7, 1.41), (0.14, 0.08, 0.08), orange)
    return b


def make_guide():
    b = Builder("guide")
    skin, jacket, jdark = "#f1c27d", "#f2b705", "#c99404"
    pants, hair = "#2f3b52", "#5b3a1e"
    for s in (-1, 1):
        b.box((s * 0.17, 0, 0.36), (0.28, 0.32, 0.62), pants)
        b.box((s * 0.17, -0.03, 0.05), (0.3, 0.4, 0.1), SHOE)
    b.box((0, 0, 1.075), (0.8, 0.46, 0.85), jacket)  # torso 0.65..1.5
    b.box((0, -0.235, 1.18), (0.2, 0.04, 0.62), WHITE)  # shirt
    b.box((0, -0.25, 1.15), (0.08, 0.04, 0.42), "#c62828")  # tie
    b.box((-0.25, -0.245, 1.28), (0.16, 0.04, 0.1), WHITE)  # badge
    b.box((0, 0, 0.7), (0.82, 0.48, 0.1), jdark)  # hem
    # left arm down
    b.box((-0.53, 0, 1.22), (0.24, 0.28, 0.5), jacket)
    b.box((-0.53, 0, 0.87), (0.2, 0.24, 0.2), skin)
    # right arm forward-holding the pole
    b.box((0.53, 0, 1.22), (0.24, 0.28, 0.5), jacket)
    b.box((0.55, -0.12, 0.95), (0.22, 0.28, 0.2), skin)
    # pole + flag
    b.box((0.58, -0.22, 1.85), (0.06, 0.06, 2.5), "#6d4c2f")
    b.box((0.58, -0.22, 3.12), (0.12, 0.12, 0.12), jacket)
    b.box((0.9, -0.22, 2.8), (0.6, 0.06, 0.44), "#e53935")
    b.box((0.9, -0.26, 2.8), (0.16, 0.02, 0.16), "#ffd54f")  # flag emblem
    # head
    b.box((0, 0, 1.95), (0.9, 0.85, 0.9), skin)  # 1.5..2.4
    b.box((0, 0.36, 2.1), (0.94, 0.2, 0.62), hair)
    for s in (-1, 1):
        b.box((s * 0.465, 0.12, 2.18), (0.06, 0.44, 0.36), hair)
        b.face(s * 0.2, 2.0, 0.12, 0.15, BLACK, protrude=0.02, front=-0.425)
    b.face(0, 1.76, 0.22, 0.05, "#8a3b2e", protrude=0.0, front=-0.425)
    # cap
    b.box((0, 0.02, 2.47), (0.96, 0.9, 0.16), jacket)
    b.box((0, -0.55, 2.42), (0.62, 0.3, 0.05), jdark)
    b.box((0, -0.455, 2.47), (0.3, 0.02, 0.1), "#c62828")
    return b


BUILDERS = [make_cat, make_dog, make_fox, make_panda, make_frog, make_monkey,
            make_lion, make_tiger, make_koala, make_penguin, make_guide]


# ---------------------------------------------------------------- scene
def setup_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    sc = bpy.context.scene
    engine = os.environ.get("SPRITE_ENGINE", "BLENDER_EEVEE")
    for eng in (engine, "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    print("ENGINE", sc.render.engine)
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = 16
        sc.cycles.use_denoising = False
    else:
        try:
            sc.eevee.taa_render_samples = 16
        except Exception:
            pass
    r = sc.render
    r.resolution_x = r.resolution_y = RES
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    r.image_settings.color_depth = "8"
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except Exception as e:
        print("view transform:", e)
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    if OUTLINE:
        r.use_freestyle = True
        r.line_thickness_mode = "ABSOLUTE"
        r.line_thickness = 1.0
        fs = bpy.context.view_layer.freestyle_settings
        ls = fs.linesets[0] if len(fs.linesets) else fs.linesets.new("LineSet")
        ls.select_by_visibility = True
        ls.select_silhouette = True
        ls.select_border = True
        ls.select_crease = False
        ls.select_external_contour = True
        sty = ls.linestyle
        sty.color = (0.06, 0.05, 0.07)
        sty.thickness = 1.0

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    tilt = math.radians(90.0 - ELEV_DEG)
    cam.rotation_euler = (tilt, 0.0, 0.0)
    fwd = Vector((0.0, math.sin(tilt), -math.cos(tilt)))
    cam.location = Vector((0, 0, 1.2)) - fwd * 20.0
    cam_data.clip_end = 100.0
    return sc, cam


def cam_bounds(cam, coll):
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for ob in coll.objects:
        for v in ob.data.vertices:
            p = inv @ (ob.matrix_world @ v.co)
            xs.append(p.x)
            ys.append(p.y)
    return min(xs), max(xs), min(ys), max(ys)


def main():
    sc, cam = setup_scene()
    chars = [fn() for fn in BUILDERS]
    bpy.context.view_layer.update()
    bounds = {b.coll.name: cam_bounds(cam, b.coll) for b in chars}
    span = 0.0
    ymin = min(bd[2] for bd in bounds.values())
    for name, (x0, x1, y0, y1) in bounds.items():
        span = max(span, 2 * max(abs(x0), abs(x1)), y1 - ymin)
        print(f"BOUNDS {name}: x[{x0:.2f},{x1:.2f}] y[{y0:.2f},{y1:.2f}]")
    margin = 0.04
    S = span / (1 - 2 * margin)
    cam.data.ortho_scale = S
    # feet bottom at margin above image bottom; x centered on 0
    cam.data.shift_x = 0.0
    cam.data.shift_y = (ymin - margin * S + S / 2) / S
    print(f"ORTHO_SCALE {S:.3f} SHIFT_Y {cam.data.shift_y:.3f}")

    paths = []
    for b in chars:
        for o in chars:
            o.coll.hide_render = o is not b
        path = os.path.join(OUT_DIR, b.coll.name + ".png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
        print("WROTE", path)
    contact_sheet(paths)


def contact_sheet(paths, cols=6, up=2):
    import numpy as np
    cell = RES * up
    rows = math.ceil(len(paths) / cols)
    W, H = cols * cell, rows * cell
    sheet = np.zeros((H, W, 4), dtype=np.float32)
    # light checker background so transparency/edges are visible
    yy, xx = np.mgrid[0:H, 0:W]
    chk = (((yy // 16) + (xx // 16)) % 2).astype(np.float32)
    bg = 0.78 + 0.08 * chk
    sheet[..., 0] = bg
    sheet[..., 1] = bg
    sheet[..., 2] = bg
    sheet[..., 3] = 1.0
    for i, p in enumerate(paths):
        img = bpy.data.images.load(p)
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)
        a = px[..., 3:4]
        nz = np.argwhere(px[..., 3] > 0.02)
        (ry0, rx0), (ry1, rx1) = nz.min(0), nz.max(0)
        print(f"ALPHA {os.path.basename(p)}: corner={px[0,0,3]:.2f} "
              f"bbox x[{rx0},{rx1}] y[{ry0},{ry1}] of {w}x{h}")
        px = np.repeat(np.repeat(px, up, 0), up, 1)
        a = px[..., 3:4]
        r, c = divmod(i, cols)
        y0 = (rows - 1 - r) * cell  # blender pixel rows start at bottom
        x0 = c * cell
        dst = sheet[y0:y0 + cell, x0:x0 + cell, :3]
        sheet[y0:y0 + cell, x0:x0 + cell, :3] = px[..., :3] * a + dst * (1 - a)
        bpy.data.images.remove(img)
    out = bpy.data.images.new("contact", W, H, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = CONTACT
    out.file_format = "PNG"
    out.save()
    print("WROTE", CONTACT)


main()
