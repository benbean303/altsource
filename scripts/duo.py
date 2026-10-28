"""iPhone Duo patch: make an app built with an older SDK fill the inner display.

iOS lays an app out on iPhone Duo's inner display based on the SDK it was
built with (27.1+ fills the screen, older is letterboxed). That SDK is
recorded in each executable's LC_BUILD_VERSION load command, so instead of
rebuilding from source we raise that number, plus the matching Info.plist
keys, in the main app and its extensions.

This breaks the original code signature, which is fine: AltStore, SideStore
and FlareStore re-sign every app before installing it.
"""

import plistlib
import re
import shutil
import struct
import zipfile

import ipa

TARGET_SDK = "27.1"


def needs_patch(sdk):
    return bool(sdk) and ipa.encode_version(sdk) < ipa.encode_version(TARGET_SDK)


def patch_binary(data):
    """Return (patched bytes, number of fields changed)."""
    target = ipa.encode_version(TARGET_SDK)
    out = bytearray(data)
    changed = 0
    for offset, value in ipa.sdk_fields(data):
        if value < target:
            struct.pack_into("<I", out, offset, target)
            changed += 1
    return bytes(out), changed


def patch_plist(data):
    binary = data.startswith(b"bplist")
    info = plistlib.loads(data)
    info["DTSDKName"] = f"iphoneos{TARGET_SDK}"
    info["DTPlatformVersion"] = TARGET_SDK
    return plistlib.dumps(info, fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML), info


def patch_ipa(src, dst):
    """Copy the .ipa at `src` to `dst` with the SDK raised. Returns the number
    of executables patched (0 means nothing needed changing)."""
    with zipfile.ZipFile(src) as zin:
        names = zin.namelist()
        app_dir = ipa._find_app_dir(names)
        bundles = [app_dir] + ipa._extension_dirs(names, app_dir)

        replacements = {}
        for bundle in bundles:
            plist_name = f"{bundle}Info.plist"
            if plist_name not in names:
                continue
            new_plist, info = patch_plist(zin.read(plist_name))
            exe = info.get("CFBundleExecutable")
            if not exe or f"{bundle}{exe}" not in names:
                continue
            new_binary, changed = patch_binary(zin.read(f"{bundle}{exe}"))
            if changed:
                replacements[f"{bundle}{exe}"] = new_binary
                replacements[plist_name] = new_plist

        if not replacements:
            return 0

        with zipfile.ZipFile(dst, "w") as zout:
            for item in zin.infolist():
                # Keep each entry's metadata (incl. the executable bit in
                # external_attr) and compression; only swap the contents.
                if item.filename in replacements:
                    zout.writestr(item, replacements[item.filename], compress_type=item.compress_type)
                else:
                    with zin.open(item) as fin, zout.open(item, "w") as fout:
                        shutil.copyfileobj(fin, fout, 1 << 20)
        return sum(1 for name in replacements if not name.endswith("Info.plist"))


def release_tag(bundle_id, version, build):
    raw = f"duo-{bundle_id}-{version}-{build}"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", raw)[:120]


def asset_name(original):
    stem, dot, ext = original.rpartition(".")
    return f"{stem}-duo.{ext}" if dot else f"{original}-duo"
