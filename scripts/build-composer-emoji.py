"""Build the composer's color font from the SVG artwork already shipped by Rajcord.

Optional asset-maintenance tool: pip install nanoemoji==0.16.0 fonttools[woff]==4.68.0
Normal pnpm builds use the checked-in WOFF2 and do not require Python.
"""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib import TTFont

ElementTree.register_namespace("", "http://www.w3.org/2000/svg")

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / ".local" / "composer-emoji"
ASSETS = ROOT / "apps/web/src/assets"


def write_changed(path, data):
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def square_viewbox(data):
    svg = ElementTree.fromstring(data)
    x, y, width, height = map(float, svg.attrib["viewBox"].split())
    if width == height:
        return data
    side = max(width, height)
    svg.set("viewBox", f"{x - (side - width) / 2:g} {y - (side - height) / 2:g} {side:g} {side:g}")
    return ElementTree.tostring(svg, encoding="utf-8")


def main():
    artwork = {}
    for directory in [ROOT / "apps/web/node_modules/twemoji-art/dist/svg", ASSETS / "emoji-extra"]:
        if not directory.is_dir():
            raise FileNotFoundError(f"Missing artwork directory: {directory}")
        artwork.update({path.name: path for path in directory.glob("*.svg")})

    sources = BUILD / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    for name, source in sorted(artwork.items()):
        data = source.read_bytes()
        digest.update(name.encode() + b"\0" + data + b"\0")
        # Match the picker's square object-fit: contain box without stretching wide artwork.
        write_changed(sources / name, square_viewbox(data))

    config = BUILD / "composer.toml"
    config_data = (
        'family = "Rajcord Composer Emoji"\n'
        'output_file = "composer-emoji.ttf"\n'
        'color_format = "glyf_colr_1"\n'
        'keep_glyph_names = true\n'
        'reuse_tolerance = 0.01\n'
        '[axis.wght]\nname = "Weight"\ndefault = 400\n'
        '[master.regular]\n'
        'style_name = "Regular"\n'
        'srcs = ' + json.dumps([(sources / name).as_posix() for name in sorted(artwork)]) +
        '\n[master.regular.position]\nwght = 400\n'
    )
    write_changed(config, config_data.encode("utf-8"))
    subprocess.run(
        [sys.executable, "-m", "nanoemoji.nanoemoji", "--build_dir=" + str(BUILD),
         "--exec_ninja=false", str(config)], check=True,
    )
    # COLRv1 writing does not consume nanoemoji's separate reusable-parts merge.
    # Build the SVG inputs directly, avoiding that unrelated optimization pass.
    with (BUILD / "build.ninja").open("a", encoding="utf-8") as graph:
        graph.write("\nbuild composer-font-inputs: phony $\n  ")
        graph.write(" $\n  ".join("picosvg/clipped/" + name for name in sorted(artwork)))
        graph.write(" $\n  composer-emoji.fea composer-emoji.glyphmap\n")
    subprocess.run(
        [shutil.which("ninja") or "ninja", "-C", str(BUILD), "-j", "8", "composer-font-inputs"],
        check=True,
    )
    subprocess.run(
        [sys.executable, "-m", "nanoemoji.write_font", "--config_file=composer-emoji.toml",
         "--fea_file=composer-emoji.fea", "--glyphmap_file=composer-emoji.glyphmap"],
        cwd=BUILD, check=True,
    )

    font = TTFont(BUILD / "composer-emoji.ttf", recalcTimestamp=False)
    ligatures = {}
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for table in lookup.SubTable:
            for first, values in getattr(table, "ligatures", {}).items():
                for value in values:
                    ligatures[(first, *value.Component)] = value.LigGlyph
    selector = font.getBestCmap().get(0xFE0F)
    for sequence, target in list(ligatures.items()):
        variant = tuple(glyph for glyph in sequence if glyph != selector)
        if len(variant) > 1:
            ligatures.setdefault(variant, target)
    # One longest-first lookup prevents a shorter emoji from consuming part of a ZWJ sequence.
    features = ["languagesystem DFLT dflt;", "languagesystem latn dflt;", "lookup Emoji {"]
    for sequence, target in sorted(ligatures.items(), key=lambda item: (-len(item[0]), item[0])):
        features.append("sub " + " ".join(sequence) + " by " + target + ";")
    features.extend(["} Emoji;", "feature ccmp { lookup Emoji; } ccmp;"])
    del font["GSUB"]
    addOpenTypeFeaturesFromString(font, "\n".join(features))
    font["name"].setName(
        "Twemoji artwork (Twitter and contributors), CC BY 4.0. "
        "Rajcord SVG sources SHA-256: " + digest.hexdigest(), 0, 3, 1, 0x409,
    )
    # Stable timestamps make repeat builds comparable.
    font["head"].created = font["head"].modified = 2082844800
    font.flavor = "woff2"
    destination = ASSETS / "composer-emoji.woff2"
    font.save(destination)
    print(f"Built {destination.name}: {len(artwork)} SVGs; source SHA-256 {digest.hexdigest()}")
    print("Font SHA-256: " + hashlib.sha256(destination.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
