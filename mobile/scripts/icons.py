# Draws the PNG app icons (installable PWAs need PNGs) to match public/icon.svg.
from PIL import Image, ImageDraw
import os
out = os.path.join(os.path.dirname(__file__), '..', 'public')
for size in (192, 512):
    s = size / 64
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(14 * s), fill='#e8283d')
    d.polygon([(14 * s, 32 * s), (32 * s, 16 * s), (50 * s, 32 * s), (50 * s, 50 * s), (14 * s, 50 * s)], fill='#ffffff')
    d.rectangle([28 * s, 36 * s, 36 * s, 50 * s], fill='#e8283d')
    d.rounded_rectangle([30.5 * s, 6 * s, 33.5 * s, 16 * s], radius=int(1.5 * s), fill='#ffd27a')
    im.save(os.path.join(out, f'icon-{size}.png'))
print('icons written')
