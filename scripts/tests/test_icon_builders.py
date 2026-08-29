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

    def run(self) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(TRAY_BUILDER),
            "--output-dir",
            str(self.tray_dir),
            "--symbol-output",
            str(self.symbol_source),
        ]
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

    def test_all_app_identity_assets_match_character_icon_generator(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            master = temp / "character-app-icon.png"
            master_result = subprocess.run(
                [
                    sys.executable,
                    str(MACOS_BUILDER),
                    "--source",
                    str(REPO / "src-tauri" / "icons" / "icon-source.png"),
                    "--output",
                    str(master),
                ],
                capture_output=True,
                text=True,
                check=False,
                cwd=REPO,
            )
            self.assertEqual(master_result.returncode, 0, master_result.stderr)

            generated = temp / "generated"
            icon_result = subprocess.run(
                [
                    "npx",
                    "tauri",
                    "icon",
                    str(master),
                    "--output",
                    str(generated),
                ],
                capture_output=True,
                text=True,
                check=False,
                cwd=REPO,
            )

            self.assertEqual(icon_result.returncode, 0, icon_result.stderr)
            tracked_root = REPO / "src-tauri" / "icons"
            generated_files = sorted(path for path in generated.rglob("*") if path.is_file())
            self.assertGreater(len(generated_files), 10)
            for expected in generated_files:
                relative = expected.relative_to(generated)
                actual = tracked_root / relative
                self.assertTrue(actual.is_file(), f"缺少角色 App 图标资产：{relative}")
                if expected.suffix == ".png":
                    with Image.open(actual) as actual_image, Image.open(expected) as expected_image:
                        self.assertEqual(actual_image.size, expected_image.size, str(relative))
                        self.assertEqual(
                            list(actual_image.convert("RGBA").getdata()),
                            list(expected_image.convert("RGBA").getdata()),
                            f"产品身份图标没有使用角色母版：{relative}",
                        )
                elif expected.suffix == ".ico":
                    with Image.open(actual) as actual_image, Image.open(expected) as expected_image:
                        self.assertEqual(actual_image.ico.sizes(), expected_image.ico.sizes())
                        for size in sorted(expected_image.ico.sizes()):
                            self.assertEqual(
                                list(actual_image.ico.getimage(size).convert("RGBA").getdata()),
                                list(expected_image.ico.getimage(size).convert("RGBA").getdata()),
                                f"Windows 产品身份图标帧没有使用角色母版：{size}",
                            )
                elif expected.suffix == ".icns":
                    with Image.open(actual) as actual_image, Image.open(expected) as expected_image:
                        self.assertEqual(actual_image.info["sizes"], expected_image.info["sizes"])
                        for size in expected_image.info["sizes"]:
                            self.assertEqual(
                                list(actual_image.icns.getimage(size).convert("RGBA").getdata()),
                                list(expected_image.icns.getimage(size).convert("RGBA").getdata()),
                                f"macOS 产品身份图标帧没有使用角色母版：{size}",
                            )
                else:
                    self.assertEqual(
                        actual.read_bytes(),
                        expected.read_bytes(),
                        f"产品身份图标没有使用角色母版：{relative}",
                    )

            with (
                Image.open(REPO / "public" / "icons" / "32x32.png") as actual_brand,
                Image.open(generated / "32x32.png") as expected_brand,
            ):
                self.assertEqual(
                    list(actual_brand.convert("RGBA").getdata()),
                    list(expected_brand.convert("RGBA").getdata()),
                    "应用内品牌 Logo 与 favicon 必须使用角色 App 图标",
                )
            with (
                Image.open(REPO / "assets" / "icon.png") as actual_readme,
                Image.open(generated / "icon.png") as expected_readme,
            ):
                self.assertEqual(
                    list(actual_readme.convert("RGBA").getdata()),
                    list(expected_readme.convert("RGBA").getdata()),
                    "README 品牌图必须使用角色 App 图标",
                )


class TrayIconBuilderTests(unittest.TestCase):
    def test_cli_only_builds_skill_core_symbol_for_system_status_area(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = TrayBuildFixture.under(Path(temp_dir))
            fixture.windows_icon.parent.mkdir(parents=True)
            fixture.public_icon.parent.mkdir(parents=True)
            Image.new("RGBA", (32, 32), (167, 91, 72, 255)).save(
                fixture.public_icon
            )
            Image.new("RGBA", (32, 32), (167, 91, 72, 255)).save(
                fixture.linux_icon_32
            )
            Image.new("RGBA", (30, 30), (167, 91, 72, 255)).save(
                fixture.windows_tile_30
            )
            Image.new("RGBA", (256, 256), (167, 91, 72, 255)).save(
                fixture.windows_icon,
                format="ICO",
                sizes=[(16, 16), (32, 32), (64, 64), (256, 256)],
            )
            Image.new("RGBA", (1024, 1024), (167, 91, 72, 255)).save(
                fixture.macos_icon,
                format="ICNS",
            )
            app_identity_assets = (
                fixture.public_icon,
                fixture.linux_icon_32,
                fixture.windows_tile_30,
                fixture.windows_icon,
                fixture.macos_icon,
            )
            original_bytes = {path: path.read_bytes() for path in app_identity_assets}

            result = fixture.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            with Image.open(fixture.symbol_source) as symbol:
                self.assertEqual(symbol.size, (1024, 1024))
            for path in app_identity_assets:
                self.assertEqual(
                    path.read_bytes(),
                    original_bytes[path],
                    f"系统状态区生成器不应改写角色 App 图标：{path}",
                )

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

if __name__ == "__main__":
    unittest.main()
