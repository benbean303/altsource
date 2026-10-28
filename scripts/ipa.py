"""Read the metadata AltStore cares about out of an .ipa file.

Pure standard library: zipfile + plistlib for the bundle, a tiny Mach-O
reader for entitlements, and a PNG decoder for Apple's "CgBI" icons.
"""

import plistlib
import posixpath
import re
import struct
import zipfile
import zlib

# Entitlements every signed app has; AltStore does not want these declared.
IMPLICIT_ENTITLEMENTS = {
    "application-identifier",
    "com.apple.developer.team-identifier",
}

PRIVACY_KEY = re.compile(r"^NS\w+UsageDescription$")


class IPAError(Exception):
    pass


def read_ipa(path):
    """Return a dict of metadata for the .ipa at `path`."""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise IPAError(f"not a valid .ipa (zip) file: {e}")

    with zf:
        names = zf.namelist()
        app_dir = _find_app_dir(names)
        info = _load_plist(zf, f"{app_dir}Info.plist")

        bundle_id = info.get("CFBundleIdentifier")
        if not bundle_id:
            raise IPAError("Info.plist has no CFBundleIdentifier")

        entitlements = set()
        privacy = {}
        for bundle_dir in [app_dir] + _extension_dirs(names, app_dir):
            bundle_info = info if bundle_dir == app_dir else _load_plist(zf, f"{bundle_dir}Info.plist", optional=True)
            if not bundle_info:
                continue
            for key, value in bundle_info.items():
                if PRIVACY_KEY.match(key) and isinstance(value, str):
                    privacy.setdefault(key, value)
            exe = bundle_info.get("CFBundleExecutable")
            if exe and f"{bundle_dir}{exe}" in names:
                entitlements |= set(_entitlements(zf.read(f"{bundle_dir}{exe}")))

        return {
            "bundleIdentifier": bundle_id,
            "name": info.get("CFBundleDisplayName") or info.get("CFBundleName"),
            "version": str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or "0"),
            "buildVersion": str(info.get("CFBundleVersion") or info.get("CFBundleShortVersionString") or "0"),
            "minOSVersion": info.get("MinimumOSVersion"),
            "entitlements": sorted(entitlements - IMPLICIT_ENTITLEMENTS),
            "privacy": dict(sorted(privacy.items())),
            "icon": _icon_png(zf, names, app_dir, info),
        }


def _find_app_dir(names):
    candidates = sorted(
        {m.group(0) for n in names if (m := re.match(r"^Payload/[^/]+\.app/", n))},
        key=len,
    )
    if not candidates:
        raise IPAError("no Payload/*.app folder inside the .ipa")
    return candidates[0]


def _extension_dirs(names, app_dir):
    pattern = re.compile(re.escape(app_dir) + r"(?:PlugIns|Extensions)/[^/]+\.appex/")
    return sorted({m.group(0) for n in names if (m := pattern.match(n))})


def _load_plist(zf, name, optional=False):
    try:
        return plistlib.loads(zf.read(name))
    except KeyError:
        if optional:
            return None
        raise IPAError(f"missing {name}")
    except Exception as e:
        if optional:
            return None
        raise IPAError(f"could not read {name}: {e}")


# --- Mach-O code signature -------------------------------------------------

FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_CODE_SIGNATURE = 0x1D
CSMAGIC_EMBEDDED_SIGNATURE = 0xFADE0CC0
CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xFADE7171
CSSLOT_ENTITLEMENTS = 5


def _entitlements(binary):
    """Entitlement keys from a (possibly fat) Mach-O binary; [] if unsigned."""
    if len(binary) < 8:
        return []
    magic = struct.unpack_from(">I", binary, 0)[0]
    slices = []
    if magic in (FAT_MAGIC, FAT_MAGIC_64):
        count = struct.unpack_from(">I", binary, 4)[0]
        offset = 8
        for _ in range(min(count, 16)):
            if magic == FAT_MAGIC:
                _, _, start, size, _ = struct.unpack_from(">5I", binary, offset)
                offset += 20
            else:
                _, _, start, size, _, _ = struct.unpack_from(">2I2Q2I", binary, offset)
                offset += 32
            slices.append(binary[start:start + size])
    else:
        slices.append(binary)

    found = set()
    for macho in slices:
        try:
            found |= set(_slice_entitlements(macho))
        except (struct.error, ValueError, plistlib.InvalidFileException):
            continue
    return sorted(found)


def _slice_entitlements(macho):
    magic = struct.unpack_from("<I", macho, 0)[0]
    if magic == 0xFEEDFACF:
        header_size = 32
    elif magic == 0xFEEDFACE:
        header_size = 28
    else:
        return []
    ncmds = struct.unpack_from("<I", macho, 16)[0]
    offset = header_size
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<2I", macho, offset)
        if cmd == LC_CODE_SIGNATURE:
            dataoff, _ = struct.unpack_from("<2I", macho, offset + 8)
            return _superblob_entitlements(macho, dataoff)
        if cmdsize == 0:
            break
        offset += cmdsize
    return []


def _superblob_entitlements(macho, base):
    magic, _, count = struct.unpack_from(">3I", macho, base)
    if magic != CSMAGIC_EMBEDDED_SIGNATURE:
        return []
    for i in range(count):
        slot, blob_offset = struct.unpack_from(">2I", macho, base + 12 + i * 8)
        if slot != CSSLOT_ENTITLEMENTS:
            continue
        blob = base + blob_offset
        blob_magic, length = struct.unpack_from(">2I", macho, blob)
        if blob_magic != CSMAGIC_EMBEDDED_ENTITLEMENTS:
            return []
        xml = macho[blob + 8: blob + length]
        if not xml.strip():
            return []
        return list(plistlib.loads(xml).keys())
    return []


# --- Icon ------------------------------------------------------------------

def _icon_png(zf, names, app_dir, info):
    """Best app icon as standard PNG bytes, or None."""
    icon_names = set()
    for key in ("CFBundleIcons", "CFBundleIcons~ipad"):
        primary = (info.get(key) or {}).get("CFBundlePrimaryIcon") or {}
        if isinstance(primary, dict):
            icon_names.update(primary.get("CFBundleIconFiles") or [])
            if primary.get("CFBundleIconName"):
                icon_names.add(primary["CFBundleIconName"])
    icon_names.update(info.get("CFBundleIconFiles") or [])
    if info.get("CFBundleIconFile"):
        icon_names.add(info["CFBundleIconFile"])

    root_pngs = [n for n in names if posixpath.dirname(n) + "/" == app_dir and n.lower().endswith(".png")]
    matches = [n for n in root_pngs if any(posixpath.basename(n).startswith(stem) for stem in icon_names)]
    if not matches:
        matches = [n for n in root_pngs if "icon" in posixpath.basename(n).lower()]
    if not matches:
        return None

    # Largest file is almost always the highest resolution icon.
    for name in sorted(matches, key=lambda n: zf.getinfo(n).file_size, reverse=True):
        try:
            return normalize_png(zf.read(name))
        except Exception:
            continue
    return None


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunks(data):
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG")
    offset = 8
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4: offset + 8]
        yield kind, data[offset + 8: offset + 8 + length]
        offset += 12 + length


def normalize_png(data):
    """Convert Apple's CgBI PNG into a normal one; pass normal PNGs through."""
    chunks = list(_chunks(data))
    if not any(kind == b"CgBI" for kind, _ in chunks):
        return data

    ihdr = next(body for kind, body in chunks if kind == b"IHDR")
    width, height, depth, color_type, _, _, interlace = struct.unpack(">2I5B", ihdr)
    if depth != 8 or color_type != 6 or interlace != 0:
        raise ValueError("unsupported CgBI PNG layout")

    raw = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"), -15)
    pixels = _unfilter(raw, width, height, 4)

    # BGRA premultiplied -> RGBA straight alpha
    for i in range(0, len(pixels), 4):
        b, g, r, a = pixels[i:i + 4]
        if 0 < a < 255:
            r, g, b = (min(255, c * 255 // a) for c in (r, g, b))
        pixels[i:i + 4] = bytes((r, g, b, a))

    return encode_png(width, height, pixels)


def _unfilter(raw, width, height, bpp):
    stride = width * bpp
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        line = bytearray(raw[pos + 1: pos + 1 + stride])
        pos += 1 + stride
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up = prev[x]
            if ftype == 1:
                line[x] = (line[x] + left) & 0xFF
            elif ftype == 2:
                line[x] = (line[x] + up) & 0xFF
            elif ftype == 3:
                line[x] = (line[x] + ((left + up) >> 1)) & 0xFF
            elif ftype == 4:
                upleft = prev[x - bpp] if x >= bpp else 0
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                pred = left if pa <= pb and pa <= pc else (up if pb <= pc else upleft)
                line[x] = (line[x] + pred) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def encode_png(width, height, rgba):
    stride = width * 4
    raw = b"".join(b"\x00" + bytes(rgba[y * stride:(y + 1) * stride]) for y in range(height))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    return (
        PNG_SIGNATURE
        + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def decode_png_rgba(data):
    """Decode an 8-bit RGB/RGBA non-interlaced PNG to (w, h, rgba) or None."""
    try:
        chunks = list(_chunks(data))
        ihdr = next(body for kind, body in chunks if kind == b"IHDR")
        width, height, depth, color_type, _, _, interlace = struct.unpack(">2I5B", ihdr)
        if depth != 8 or interlace != 0 or color_type not in (2, 6):
            return None
        bpp = 4 if color_type == 6 else 3
        raw = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"))
        pixels = _unfilter(raw, width, height, bpp)
        if bpp == 3:
            rgba = bytearray()
            for i in range(0, len(pixels), 3):
                rgba += pixels[i:i + 3] + b"\xff"
            pixels = rgba
        return width, height, pixels
    except Exception:
        return None


def tint_color(png):
    """A pleasant accent color picked from the icon, as #RRGGBB, or None."""
    decoded = decode_png_rgba(png) if png else None
    if not decoded:
        return None
    width, height, rgba = decoded
    step = max(1, (width * height) // 4096)
    buckets = {}
    for i in range(0, width * height, step):
        r, g, b, a = rgba[i * 4: i * 4 + 4]
        if a < 200:
            continue
        hi, lo = max(r, g, b), min(r, g, b)
        if hi < 50 or hi - lo < 40:  # skip near-black and greys/whites
            continue
        key = (r >> 4, g >> 4, b >> 4)
        weight = (hi - lo)
        total = buckets.setdefault(key, [0, 0, 0, 0])
        total[0] += r * weight
        total[1] += g * weight
        total[2] += b * weight
        total[3] += weight
    if not buckets:
        return None
    r, g, b, w = max(buckets.values(), key=lambda t: t[3])
    return "#{:02X}{:02X}{:02X}".format(r // w, g // w, b // w)
