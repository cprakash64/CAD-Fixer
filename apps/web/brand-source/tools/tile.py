"""Place the Pybrix mark on its native white ground, pixel for pixel.

Mark pixels are composited with straight alpha over white; nothing is recoloured,
scaled or moved relative to itself. `rounded` gives transparent, anti-aliased
corners (favicon / header tile); otherwise the square is fully opaque (Apple
touch icon, which iOS masks itself and fills with black if left transparent).
"""
import sys, zlib, struct
from png import read

def write(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0); raw += rgba[y*w*4:(y+1)*w*4]
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))

def coverage(x, y, S, r):
    # 4x4 supersampled rounded-rect coverage, 0..1
    hits = 0
    for sy in range(4):
        for sx in range(4):
            px = x + (sx + 0.5) / 4; py = y + (sy + 0.5) / 4
            cx = min(max(px, r), S - r); cy = min(max(py, r), S - r)
            if (px - cx) ** 2 + (py - cy) ** 2 <= r * r: hits += 1
    return hits / 16

src, out, rounded = sys.argv[1], sys.argv[2], sys.argv[3] == 'rounded'
mw, mh, mark = read(src)
S = 1152; off = (S - mw) // 2; r = S * 0.2237
canvas = bytearray(S * S * 4)
for y in range(S):
    for x in range(S):
        R = G = B = 255
        mx, my = x - off, y - off
        if 0 <= mx < mw and 0 <= my < mh:
            i = (my * mw + mx) * 4; a = mark[i + 3] / 255
            R = round(mark[i] * a + 255 * (1 - a)); G = round(mark[i+1] * a + 255 * (1 - a)); B = round(mark[i+2] * a + 255 * (1 - a))
        if rounded:
            edge = x < r or x >= S - r
            A = round(255 * coverage(x, y, S, r)) if (edge and (y < r or y >= S - r)) else 255
        else:
            A = 255
        j = (y * S + x) * 4; canvas[j:j+4] = bytes((R, G, B, A))
write(out, S, S, canvas)
print('wrote', out, S, 'x', S)
