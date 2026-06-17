"""Generate the extension's PNG icons (no external deps).

Rasterizes icon.svg's design — a red outline circle with a diagonal slash (the
universal "block" sign) — on a transparent background, supersampled 4x.
"""
import struct
import zlib
import math


def make_png(size, path):
    ss = 4
    s = size * ss
    cx = cy = (s - 1) / 2.0
    # Mirror icon.svg's 24-unit geometry: r=10.5, stroke=1.91, line corners
    # at (19.64,4.36)->(4.36,19.64). Scale by (s/24); inset slightly so the
    # stroke isn't clipped at the edges.
    unit = s / 24.0
    stroke = 1.91 * unit
    half_stroke = stroke / 2.0
    radius = 10.5 * unit
    inv_sqrt2 = 1.0 / math.sqrt(2)
    # diagonal line endpoints (the "\" direction), as a center-relative line
    line_len_half = (19.64 - 4.36) / 2.0 * unit  # half the drawn span

    red = (255, 0, 51)

    def sample(x, y):
        dx = x - cx
        dy = y - cy
        d = math.sqrt(dx * dx + dy * dy)
        on_ring = abs(d - radius) <= half_stroke
        # distance to the "\" diagonal through the center, and clamp to its span
        perp = abs(dx + dy) * inv_sqrt2          # 0 on the "\" line
        along = abs(dx - dy) * inv_sqrt2         # position along the line
        on_line = perp <= half_stroke and along <= line_len_half
        if on_ring or on_line:
            return (red[0], red[1], red[2], 255)
        return (0, 0, 0, 0)

    rows = []
    for oy in range(size):
        row = bytearray()
        row.append(0)  # PNG filter type 0 for this scanline
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    pr, pg, pb, pa = sample(ox * ss + sx, oy * ss + sy)
                    # premultiply so transparent edges don't darken
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = ss * ss
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (
                        round(r / a),
                        round(g / a),
                        round(b / a),
                        round(a / n),
                    )
                )
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
    print("wrote", path)


for sz in (16, 48, 128):
    make_png(sz, "icon%d.png" % sz)
