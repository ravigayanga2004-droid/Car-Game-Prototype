#!/usr/bin/env python3
"""Build optimized runtime assets into public/assets from assets/src-* and assets/catalog.

Run: python3 scripts/build-assets.py   (idempotent; requires Pillow + ffmpeg)
"""
import json, os, shutil, subprocess
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ART = os.path.join(ROOT, 'assets/src-art')
SRC_AUD = os.path.join(ROOT, 'assets/src-audio')
CAT = os.path.join(ROOT, 'assets/catalog')
OUT = os.path.join(ROOT, 'public/assets')


def out(*p):
    path = os.path.join(OUT, *p)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def fit(img, w):
    if img.width <= w:
        return img
    return img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)


def trim_alpha(img, pad=8):
    a = img.getchannel('A').point(lambda v: 255 if v > 10 else 0)
    box = a.getbbox()
    if not box:
        return img
    l, t, r, b = box
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def clean_halo(img):
    """Remove dark semi-transparent fringe that some generated icons carry."""
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            lum = (r * 3 + g * 6 + b) / 10
            if a < 250 and lum < 70:
                px[x, y] = (r, g, b, int(a * max(0.0, (lum - 20) / 50)))
    return img


def sprite(name, size=256):
    img = Image.open(os.path.join(SRC_ART, f'fx-{name}.png')).convert('RGBA')
    img = trim_alpha(img, 24)
    s = max(img.width, img.height)
    sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    sq.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
    sq = sq.resize((size, size), Image.LANCZOS)
    # Fade the outer border so no sprite ever shows a hard square edge.
    a = sq.getchannel('A')
    mask = Image.new('L', (size, size), 0)
    m = mask.load()
    for y in range(size):
        for x in range(size):
            dx = min(x, size - 1 - x) / (size * 0.08)
            dy = min(y, size - 1 - y) / (size * 0.08)
            m[x, y] = int(255 * max(0.0, min(1.0, dx, dy)))
    from PIL import ImageChops
    sq.putalpha(ImageChops.multiply(a, mask))
    return sq


def procedural(kind, size=256):
    import math
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    px = img.load()
    c = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            dx, dy = (x - c) / c, (y - c) / c
            if kind == 'ring':
                r = math.hypot(dx, dy)
                a = math.exp(-((r - 0.78) / 0.09) ** 2) + 0.35 * math.exp(-((r - 0.62) / 0.22) ** 2) * (r < 0.8)
            elif kind == 'confetti':
                ax, ay = abs(dx) / 0.8, abs(dy) / 0.45
                a = 1.0 if max(ax, ay) < 1 else max(0.0, 1 - (max(ax, ay) - 1) * 12)
            else:  # 'line': soft horizontal streak for speed lines / wind ribbons
                a = math.exp(-(dy / 0.12) ** 2) * max(0.0, 1 - abs(dx)) ** 0.7
            px[x, y] = (255, 255, 255, int(255 * max(0.0, min(1.0, a))))
    return img


def atlas():
    """4x2 grid of 256px cells: smoke dust flame spark / glow ring confetti line."""
    cells = [sprite('smoke'), sprite('dust'), sprite('flame'), sprite('spark'), sprite('glow'), procedural('ring'), procedural('confetti'), procedural('line')]
    sheet = Image.new('RGBA', (1024, 512), (0, 0, 0, 0))
    for i, cell in enumerate(cells):
        sheet.paste(cell, ((i % 4) * 256, (i // 4) * 256))
    sheet.save(out('fx', 'atlas.png'), optimize=True)


def textures():
    maps = {
        'cliff': 'polyhaven-cliff_side/cliff_side',
        'sand': 'polyhaven-aerial_sand/aerial_sand',
        'asphalt': 'polyhaven-asphalt_track/asphalt_track',
        'sandstone': 'polyhaven-red_sandstone_wall/red_sandstone_wall',
        'rocks': 'polyhaven-coast_sand_rocks_02/coast_sand_rocks_02',
    }
    for key, base in maps.items():
        for kind, suffix, w in (('diff', 'diff', 1024), ('nor', 'nor_gl', 512), ('arm', 'arm', 512)):
            src = os.path.join(CAT, f'{base}_{suffix}_1k.jpg')
            img = fit(Image.open(src).convert('RGB'), w)
            img.save(out('tex', f'{key}_{kind}.jpg'), quality=82 if kind == 'diff' else 78, optimize=True, progressive=True)


def art():
    sky = Image.open(os.path.join(SRC_ART, 'sky-pano.png')).convert('RGB')
    fit(sky, 2048).save(out('sky', 'sky.jpg'), quality=84, optimize=True, progressive=True)
    bg = Image.open(os.path.join(SRC_ART, 'loading-bg.jpg')).convert('RGB')
    fit(bg, 1600).save(out('ui', 'loading-bg.webp'), quality=72, method=6)
    fit(bg, 960).save(out('ui', 'loading-bg-sm.webp'), quality=70, method=6)
    logo = trim_alpha(Image.open(os.path.join(SRC_ART, 'logo.png')).convert('RGBA'), 6)
    fit(logo, 900).save(out('ui', 'logo.webp'), quality=88, method=6)
    for icon in ('seeker', 'mine', 'shield'):
        img = Image.open(os.path.join(SRC_ART, f'icon-{icon}.png')).convert('RGBA')
        img = clean_halo(fit(img, 512))
        img = trim_alpha(img, 10)
        s = max(img.width, img.height)
        sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        sq.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
        sq.resize((160, 160), Image.LANCZOS).save(out('ui', f'icon-{icon}.webp'), quality=90, method=6)
    atlas()


def models():
    # Photoreal cars and props: generated (Higgsfield / Tripo H3.1 image-to-3D and text-to-3D),
    # then optimised with glTF-Transform (quantize + WebP textures) into assets/src-3d/opt.
    # Cars: --texture-size 1024 --simplify-ratio 0.7 (dune, scorchquill) or 0.5 --simplify-error 0.002
    # (mesa, arroyo, sidewinder, longhorn, stingbolt: the denser PASS 12 regenerations), keeping staged transfer < 9 MB.
    gen = os.path.join(ROOT, 'assets', 'src-3d', 'opt')
    for key in ['mesa', 'dune', 'arroyo', 'sidewinder', 'longhorn', 'stingbolt', 'scorchquill', 'boulder', 'spire', 'saguaro', 'seeker', 'mine']:
        shutil.copyfile(os.path.join(gen, f'{key}.glb'), out('models', f'{key}.glb'))
    names = {
        'gantry': 'start-finish-gantry-bccfbd22',
        'tower': 'light-tower-ae4ade95',
    }
    for key, file in names.items():
        shutil.copyfile(os.path.join(CAT, 'gt-paddock', f'endurance-and-gt-paddock-{file}.glb'), out('models', f'{key}.glb'))


def audio():
    for f in sorted(os.listdir(SRC_AUD)):
        if not f.endswith('.mp3'):
            continue
        src = os.path.join(SRC_AUD, f)
        is_music = f.startswith('music-')
        dst = out('audio', f.replace('sfx-', '').replace('music-', 'm-'))
        af = 'loudnorm=I=-16:TP=-1.5:LRA=11' if is_music else 'loudnorm=I=-14:TP=-1.0:LRA=7'
        args = ['ffmpeg', '-y', '-v', 'error', '-i', src, '-af', af, '-ar', '44100']
        if is_music:
            args += ['-ac', '2', '-b:a', '112k']
        else:
            args += ['-ac', '1', '-b:a', '96k']
        subprocess.run(args + [dst], check=True)


if __name__ == '__main__':
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)
    textures(); art(); models(); audio()
    total = 0
    listing = {}
    for dp, _, fs in os.walk(OUT):
        for f in fs:
            p = os.path.join(dp, f)
            total += os.path.getsize(p)
            listing[os.path.relpath(p, OUT)] = os.path.getsize(p)
    print(json.dumps({'files': len(listing), 'bytes': total}, indent=1))
