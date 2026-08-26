from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
MACOS_BUILDER = REPO / "scripts" / "build_macos_icon.py"
TRAY_BUILDER = REPO / "scripts" / "build_tray_icons.py"


@dataclass(frozen=True)
class TrayBuildFixture:
    tray_dir: Path
    public_icon: Path
    symbol_source: Path
    linux_icon_32: Path
    windows_tile_30: Path
    windows_icon: Path
    macos_icon: Path

    @classmethod
    def under(cls, root: Path) -> "TrayBuildFixture":
        bundle_dir = root / "bundle"
        return cls(
            tray_dir=root / "tray",
            public_icon=root / "public" / "32x32.png",
            symbol_source=root / "skill-core-symbol.png",
            linux_icon_32=bundle_dir / "32x32.png",
            windows_tile_30=bundle_dir / "Square30x30Logo.png",
            windows_icon=bundle_dir / "icon.ico",
            macos_icon=bundle_dir / "icon.icns",
        )

    def run(self, *, patch_macos_bundle: bool = False) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(TRAY_BUILDER),
            "--output-dir",
            str(self.tray_dir),
            "--public-icon",
            str(self.public_icon),
            "--symbol-output",
            str(self.symbol_source),
            "--bundle-icon-32",
            str(self.linux_icon_32),
            "--windows-tile-30",
            str(self.windows_tile_30),
            "--ico-output",
            str(self.windows_icon),
            "--icns-output",
            str(self.macos_icon),
        ]
        if not patch_macos_bundle:
            command.append("--skip-icns")
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )


class MacOSIconBuilderTests(unittest.TestCase):
    def test_cli_builds_full_bleed_squircle_from_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "source.png"
            output = temp / "icon.png"
            source_color = (31, 45, 88, 255)
            Image.new("RGBA", (128, 128), source_color).save(source)

            result = subprocess.run(
                [
                    sys.executable,
                    str(MACOS_BUILDER),
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists(), result.stdout)

            with Image.open(output) as output_icon:
                icon = output_icon.convert("RGBA")
                self.assertEqual(icon.size, (1024, 1024))
                self.assertEqual(icon.getpixel((0, 0))[3], 0)
                self.assertEqual(icon.getpixel((512, 512)), source_color)

                # 满版插画应延伸到连续圆角矩形边缘，不再保留旧版内缩 S 插画的白色边框。
                edge_pixel = icon.getpixel((120, 512))
                self.assertEqual(edge_pixel[:3], source_color[:3])
                self.assertGreater(edge_pixel[3], 250)


class TrayIconBuilderTests(unittest.TestCase):
    def test_cli_builds_skill_core_symbol_icons_for_small_surfaces(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = TrayBuildFixture.under(Path(temp_dir))
            fixture.windows_icon.parent.mkdir(parents=True)
            Image.new("RGBA", (64, 64), (167, 91, 72, 255)).save(
                fixture.windows_icon,
                format="ICO",
                sizes=[(16, 16), (32, 32), (64, 64)],
            )

            result = fixture.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            with Image.open(fixture.symbol_source) as symbol:
                self.assertEqual(symbol.size, (1024, 1024))
            with Image.open(fixture.public_icon) as sidebar_icon:
                self.assertEqual(sidebar_icon.size, (32, 32))
            with Image.open(fixture.windows_tile_30) as tile:
                self.assertEqual(tile.size, (30, 30))
                self.assertGreater(len(set(tile.convert("RGBA").getdata())), 4)

            for size in (16, 20, 24, 32):
                with (
                    Image.open(fixture.tray_dir / f"tray-icon-{size}.png") as mono_source,
                    Image.open(fixture.tray_dir / f"tray-icon-color-{size}.png") as color_source,
                ):
                    monochrome = mono_source.convert("RGBA")
                    colored = color_source.convert("RGBA")
                    self.assertEqual(monochrome.size, (size, size))
                    self.assertEqual(colored.size, (size, size))

                    mono_opaque_colors = {
                        pixel[:3] for pixel in monochrome.getdata() if pixel[3] > 16
                    }
                    self.assertEqual(mono_opaque_colors, {(255, 255, 255)})

                    # 彩色版本必须同时保留青色星环与粉色核心，不能退化为单色轮廓。
                    color_opaque_colors = {
                        pixel[:3] for pixel in colored.getdata() if pixel[3] > 128
                    }
                    self.assertGreater(len(color_opaque_colors), 2)

                    for background in ((255, 255, 255), (23, 20, 38)):
                        contrast_scores = []
                        for red, green, blue, alpha in colored.getdata():
                            if alpha <= 16:
                                continue
                            opacity = alpha / 255
                            composited = (
                                round(red * opacity + background[0] * (1 - opacity)),
                                round(green * opacity + background[1] * (1 - opacity)),
                                round(blue * opacity + background[2] * (1 - opacity)),
                            )
                            channels = zip(composited, background)
                            contrast_scores.append(
                                sum(
                                    abs(channel - backdrop)
                                    for channel, backdrop in channels
                                )
                            )
                        clearly_visible = sum(score > 75 for score in contrast_scores)
                        self.assertGreater(
                            clearly_visible, len(contrast_scores) * 0.25
                        )

    def test_cli_uses_skill_core_symbol_for_small_desktop_app_icons(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = TrayBuildFixture.under(Path(temp_dir))

            legacy_character = Image.new("RGBA", (256, 256), (167, 91, 72, 255))
            fixture.windows_icon.parent.mkdir(parents=True)
            legacy_character.save(
                fixture.windows_icon,
                format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)],
            )

            result = fixture.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            with (
                Image.open(fixture.public_icon) as sidebar_icon,
                Image.open(fixture.linux_icon_32) as bundle_icon,
            ):
                self.assertEqual(list(bundle_icon.getdata()), list(sidebar_icon.getdata()))
            with Image.open(fixture.windows_tile_30) as tile:
                self.assertEqual(tile.size, (30, 30))
                self.assertGreater(len(set(tile.convert("RGBA").getdata())), 4)

            with Image.open(fixture.windows_icon) as ico:
                for size in (16, 24, 32):
                    small_frame = ico.ico.getimage((size, size)).convert("RGBA")
                    self.assertGreater(len(set(small_frame.getdata())), 4)
                    center_pixel = small_frame.getpixel((size // 2, size // 2))[:3]
                    self.assertNotEqual(center_pixel, (167, 91, 72))

                character_frame = ico.ico.getimage((64, 64)).convert("RGBA")
                self.assertEqual(character_frame.getpixel((32, 32))[:3], (167, 91, 72))

    @unittest.skipUnless(sys.platform == "darwin", "iconutil 仅在 macOS 上可用")
    def test_cli_uses_skill_core_symbol_for_small_macos_app_icons(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            fixture = TrayBuildFixture.under(temp)
            legacy_color = (167, 91, 72, 255)
            iconset = temp / "legacy.iconset"
            iconset.mkdir()
            iconset_sizes = {
                "icon_16x16.png": 16,
                "icon_16x16@2x.png": 32,
                "icon_32x32.png": 32,
                "icon_32x32@2x.png": 64,
                "icon_128x128.png": 128,
                "icon_128x128@2x.png": 256,
                "icon_256x256.png": 256,
                "icon_256x256@2x.png": 512,
                "icon_512x512.png": 512,
                "icon_512x512@2x.png": 1024,
            }
            for name, size in iconset_sizes.items():
                Image.new("RGBA", (size, size), legacy_color).save(iconset / name)

            fixture.macos_icon.parent.mkdir(parents=True)
            subprocess.run(
                [
                    "iconutil",
                    "-c",
                    "icns",
                    str(iconset),
                    "-o",
                    str(fixture.macos_icon),
                ],
                check=True,
                capture_output=True,
            )

            Image.new("RGBA", (256, 256), legacy_color).save(
                fixture.windows_icon,
                format="ICO",
                sizes=[(16, 16), (32, 32), (64, 64), (256, 256)],
            )
            result = fixture.run(patch_macos_bundle=True)
            self.assertEqual(result.returncode, 0, result.stderr)

            audited_iconset = temp / "audited.iconset"
            subprocess.run(
                [
                    "iconutil",
                    "-c",
                    "iconset",
                    str(fixture.macos_icon),
                    "-o",
                    str(audited_iconset),
                ],
                check=True,
                capture_output=True,
            )
            for name in ("icon_16x16.png", "icon_16x16@2x.png", "icon_32x32.png"):
                with Image.open(audited_iconset / name) as small_frame:
                    center = small_frame.size[0] // 2
                    center_pixel = small_frame.getpixel((center, center))[:3]
                    self.assertNotEqual(center_pixel, legacy_color[:3])

            with Image.open(audited_iconset / "icon_32x32@2x.png") as character_frame:
                self.assertEqual(character_frame.getpixel((32, 32))[:3], legacy_color[:3])


if __name__ == "__main__":
    unittest.main()
