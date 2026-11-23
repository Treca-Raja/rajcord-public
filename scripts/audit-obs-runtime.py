"""Audit the native binaries in an extracted, locally built Windows installer."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import struct
from pathlib import Path


FFMPEG_DLLS = {
    "avcodec": "avcodec-62.dll", "avdevice": "avdevice-62.dll", "avfilter": "avfilter-11.dll",
    "avformat": "avformat-62.dll", "avutil": "avutil-60.dll", "swresample": "swresample-6.dll",
    "swscale": "swscale-9.dll",
}


class PortableExecutable:
    def __init__(self, binary):
        self.binary = binary
        pe = self.read32(0x3C)
        if binary[pe:pe + 4] != b"PE\0\0":
            raise ValueError("Expected a Portable Executable")
        section_count = struct.unpack_from("<H", binary, pe + 6)[0]
        optional_size = struct.unpack_from("<H", binary, pe + 20)[0]
        optional = pe + 24
        magic = struct.unpack_from("<H", binary, optional)[0]
        self.directories = optional + {0x10B: 96, 0x20B: 112}[magic]
        self.thunk_format = {0x10B: "<I", 0x20B: "<Q"}[magic]
        self.thunk_size = struct.calcsize(self.thunk_format)
        self.image_base = struct.unpack_from(self.thunk_format, binary, optional + {0x10B: 28, 0x20B: 24}[magic])[0]
        section_table = optional + optional_size
        self.sections = [
            struct.unpack_from("<IIII", binary, section_table + 40 * index + 8)
            for index in range(section_count)
        ]

    def read32(self, address):
        return struct.unpack_from("<I", self.binary, address)[0]

    def offset(self, rva):
        for _, virtual, size, raw in self.sections:
            if virtual <= rva < virtual + size:
                return raw + rva - virtual
        raise ValueError("Address points outside its PE section")

    def string(self, rva, skip=0):
        pos = self.offset(rva) + skip
        return self.binary[pos:self.binary.index(b"\0", pos)].decode("ascii")

    def directory(self, index):
        rva, size = struct.unpack_from("<II", self.binary, self.directories + index * 8)
        return (self.offset(rva), size) if rva and size else (0, 0)

    def imports(self, delayed=False):
        start, size = self.directory(13 if delayed else 1)
        width = 32 if delayed else 20
        libraries = {}
        for address in range(start, start + size, width):
            fields = struct.unpack_from("<8I" if delayed else "<5I", self.binary, address)
            if not any(fields):
                break
            base = self.image_base if delayed and not (fields[0] & 1) else 0
            name = self.string((fields[1] if delayed else fields[3]) - base)
            if name.lower() not in FFMPEG_DLLS.values():
                libraries.setdefault(name, [])
                continue
            thunk = (fields[4] if delayed else fields[0] or fields[4]) - base
            symbols = libraries.setdefault(name, [])
            index = self.offset(thunk)
            ordinal_bit = 1 << (8 * self.thunk_size - 1)
            while value := struct.unpack_from(self.thunk_format, self.binary, index)[0]:
                symbols.append(f"#{value & 0xFFFF}" if value & ordinal_bit else self.string(value - base, 2))
                index += self.thunk_size
        return libraries

    def exports(self):
        start, size = self.directory(0)
        if not size:
            return set()
        base, functions, names, addresses, name_table, _ = struct.unpack_from("<6I", self.binary, start + 16)
        function_table = self.offset(addresses)
        name_table = self.offset(name_table) if names else 0
        return {f"#{base + i}" for i in range(functions) if self.read32(function_table + 4 * i)} | {
            self.string(self.read32(name_table + 4 * i)) for i in range(names)
        }


def ffmpeg_exports(folder):
    result = {}
    with os.add_dll_directory(str(folder)):
        for base, filename in FFMPEG_DLLS.items():
            library = ctypes.CDLL(str(folder / filename))
            info = {}
            for key in ("license", "configuration"):
                lookup = getattr(library, f"{base}_{key}")
                lookup.restype = ctypes.c_char_p
                info[key] = lookup().decode("ascii")
            if base == "avutil":
                library.av_version_info.restype = ctypes.c_char_p
                info["version"] = library.av_version_info().decode("ascii")
            result[filename] = info
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="extracted obs-screen directory")
    parser.add_argument("--ffmpeg-candidate", type=Path, help="directory with the seven candidate FFmpeg DLLs")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Run on Windows to inspect the actual FFmpeg library metadata.")
    root = args.bundle.resolve(strict=True)
    inventory = json.loads((root / "inventory.json").read_text(encoding="utf-8-sig"))
    binaries = {}
    required = {}
    for entry in inventory:
        relative = entry["path"]
        file = (root / relative).resolve(strict=True)
        if not file.is_relative_to(root):
            raise ValueError(f"File outside the audited bundle: {relative}")
        data = file.read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        if actual != entry["sha256"]:
            raise ValueError(f"Installer inventory hash mismatch: {relative}")
        if file.suffix.lower() in {".dll", ".exe"}:
            image = PortableExecutable(data)
            linked, delayed = image.imports(), image.imports(delayed=True)
            binaries[relative] = {
                "sha256": actual, "imports": sorted(linked, key=str.lower), "delayImports": sorted(delayed, key=str.lower)
            }
            if file.name.lower() not in FFMPEG_DLLS.values():
                for name, symbols in (*linked.items(), *delayed.items()):
                    if symbols:
                        required.setdefault(name.lower(), {}).setdefault(relative, set()).update(symbols)
    report = {"binaries": binaries, "ffmpeg": ffmpeg_exports(root / "bin")}
    for relative, image in binaries.items():
        for library in image["imports"] + image["delayImports"]:
            if library.lower().startswith(("gst", "libgst")):
                raise ValueError(f"Retired transport import in {relative}: {library}")
    for binary, dependencies in {
        "bin/rajcord-obs.exe": ("obs.dll", "datachannel.dll", r"(?:lib)?opus(?:-0)?\.dll"),
        "bin/datachannel.dll": (r"(?:lib)?nice(?:-10)?\.dll", "libssl-3-x64.dll", "libcrypto-3-x64.dll"),
    }.items():
        for dependency in dependencies:
            if not any(re.fullmatch(dependency, name, re.I) and (root / "bin" / name).is_file()
                       for name in binaries[binary]["imports"]):
                raise ValueError(f"Missing native import or local DLL in {binary}: {dependency}")
    missing = False
    if args.ffmpeg_candidate:
        comparison = report["ffmpegCandidate"] = {}
        for library, consumers in sorted(required.items()):
            data = (args.ffmpeg_candidate / library).read_bytes()
            exports = PortableExecutable(data).exports()
            checked = {path: {"required": sorted(names), "missing": sorted(names - exports)}
                       for path, names in sorted(consumers.items())}
            comparison[library] = {"sha256": hashlib.sha256(data).hexdigest(), "consumers": checked}
            missing |= any(result["missing"] for result in checked.values())
    print(json.dumps(report, indent=2))
    if missing:
        raise SystemExit("FFmpeg candidate is missing imported symbols. See the JSON report.")


if __name__ == "__main__":
    main()
