"""生成小尺寸场景使用的技能核心符号图标体系。

人物插画仅用于 64px 及以上尺寸；在 16–32px 场景中，技能核心符号的五角星与单条星环
仍能保持清晰辨识。

用法：
    # 在 `npx tauri icon src-tauri/icons/icon.png` 之后运行，
    # 仅替换已生成桌面 bundle 中的小尺寸帧。
    python scripts/build_tray_icons.py

输出：
    src-tauri/icons/skill-core-symbol.png                     （1024px 源图）
    public/icons/32x32.png                                    （侧栏/favicon）
    src-tauri/icons/32x32.png                                 （Linux bundle）
    src-tauri/icons/Square30x30Logo.png                       （Windows 磁贴）
    src-tauri/icons/icon.ico                                  （Windows 混合尺寸）
    src-tauri/icons/icon.icns                                 （macOS 混合尺寸）
    src-tauri/icons/tray/tray-icon-{16,20,24,32}.png         （单色）
    src-tauri/icons/tray/tray-icon-color-{16,20,24,32}.png   （彩色）
"""
from __future__ import annotations

import argparse
import io
import math
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw


REPO = Path(__file__).resolve().parent.parent
TRAY_DIR = REPO / "src-tauri" / "icons" / "tray"
PUBLIC_ICON = REPO / "public" / "icons" / "32x32.png"
SYMBOL_OUTPUT = REPO / "src-tauri" / "icons" / "skill-core-symbol.png"
BUNDLE_ICON_32 = REPO / "src-tauri" / "icons" / "32x32.png"
WINDOWS_TILE_30 = REPO / "src-tauri" / "icons" / "Square30x30Logo.png"
ICO_OUTPUT = REPO / "src-tauri" / "icons" / "icon.ico"
ICNS_OUTPUT = REPO / "src-tauri" / "icons" / "icon.icns"
SIZES = (16, 20, 24, 32)
SSAA = 8

INDIGO = (39, 29, 86, 255)
CYAN = (91, 231, 236, 255)
PINK = (255, 139, 196, 255)
WHITE = (255, 255, 255, 255)


@dataclass(frozen=True)
class IconBuildOutputs:
    tray_dir: Path
    public_icon: Path
    symbol_source: Path
    linux_icon_32: Path
    windows_tile_30: Path
    windows_icon: Path
    macos_icon: Path


DEFAULT_OUTPUTS = IconBuildOutputs(
    tray_dir=TRAY_DIR,
    public_icon=PUBLIC_ICON,
    symbol_source=SYMBOL_OUTPUT,
    linux_icon_32=BUNDLE_ICON_32,
    windows_tile_30=WINDOWS_TILE_30,
    windows_icon=ICO_OUTPUT,
    macos_icon=ICNS_OUTPUT,
)


def star_points(cx: float, cy: float, outer: float, inner: float) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(10):
        angle = -math.pi / 2 + index * math.pi / 5
        radius = outer if index % 2 == 0 else inner
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return points


def render_skill_core_symbol(size: int, monochrome: bool) -> Image.Image:
    supersampled_size = size * SSAA
    center = supersampled_size / 2
    canvas = Image.new("RGBA", (supersampled_size, supersampled_size), (0, 0, 0, 0))

    orbit = Image.new("RGBA", (supersampled_size, supersampled_size), (0, 0, 0, 0))
    orbit_draw = ImageDraw.Draw(orbit)
    orbit_color = WHITE if monochrome else CYAN
    orbit_draw.ellipse(
        (
            supersampled_size * 0.08,
            supersampled_size * 0.34,
            supersampled_size * 0.92,
            supersampled_size * 0.66,
        ),
        outline=orbit_color,
        width=max(SSAA, round(supersampled_size * 0.075)),
    )
    orbit = orbit.rotate(-17, resample=Image.Resampling.BICUBIC)
    canvas.alpha_composite(orbit)

    draw = ImageDraw.Draw(canvas)
    if not monochrome:
        orb_radius = supersampled_size * 0.235
        draw.ellipse(
            (
                center - orb_radius,
                center - orb_radius,
                center + orb_radius,
                center + orb_radius,
            ),
            fill=INDIGO,
            outline=WHITE,
            width=max(SSAA, round(supersampled_size * 0.035)),
        )

    star_color = WHITE if monochrome else PINK
    draw.polygon(
        star_points(
            center,
            center,
            supersampled_size * 0.245,
            supersampled_size * 0.112,
        ),
        fill=star_color,
    )
    if not monochrome:
        highlight = supersampled_size * 0.035
        draw.ellipse(
            (center - highlight, center - highlight, center + highlight, center + highlight),
            fill=WHITE,
        )

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def replace_small_windows_icon_frames(output: Path) -> None:
    if not output.exists():
        raise SystemExit(f"缺少 Windows 图标 bundle：{output}")

    with Image.open(output) as existing_icon:
        sizes = sorted(existing_icon.ico.sizes())
        frames: list[tuple[tuple[int, int], bytes]] = []
        for size in sizes:
            if max(size) <= 32:
                frame = render_skill_core_symbol(size[0], monochrome=False)
            else:
                frame = existing_icon.ico.getimage(size).convert("RGBA")
            encoded = io.BytesIO()
            frame.save(encoded, format="PNG", optimize=True)
            frames.append((size, encoded.getvalue()))

    directory_size = 6 + 16 * len(frames)
    offset = directory_size
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    payload = bytearray()
    for (width, height), encoded in frames:
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if width == 256 else width,
                0 if height == 256 else height,
                0,
                0,
                1,
                32,
                len(encoded),
                offset,
            )
        )
        payload.extend(encoded)
        offset += len(encoded)

    output.write_bytes(directory + payload)


def replace_small_macos_icon_frames(output: Path) -> None:
    if sys.platform != "darwin":
        print(f"已跳过 {output}：iconutil 仅在 macOS 上可用")
        return
    if not output.exists():
        raise SystemExit(f"缺少 macOS 图标 bundle：{output}")

    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        iconset = temp / "icon.iconset"
        subprocess.run(
            ["iconutil", "-c", "iconset", str(output), "-o", str(iconset)],
            check=True,
        )
        small_frames = {
            "icon_16x16.png": 16,
            "icon_16x16@2x.png": 32,
            "icon_32x32.png": 32,
        }
        for name, size in small_frames.items():
            render_skill_core_symbol(size, monochrome=False).save(
                iconset / name, format="PNG", optimize=True
            )

        hybrid_output = temp / "hybrid.icns"
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(hybrid_output)],
            check=True,
        )
        hybrid_output.replace(output)


def main(
    outputs: IconBuildOutputs = DEFAULT_OUTPUTS,
    *,
    patch_macos_bundle: bool = True,
) -> None:
    outputs.tray_dir.mkdir(parents=True, exist_ok=True)
    outputs.public_icon.parent.mkdir(parents=True, exist_ok=True)
    outputs.symbol_source.parent.mkdir(parents=True, exist_ok=True)

    render_skill_core_symbol(1024, monochrome=False).save(
        outputs.symbol_source, format="PNG", optimize=True
    )
    color_symbol_32 = render_skill_core_symbol(32, monochrome=False)
    color_symbol_32.save(outputs.public_icon, format="PNG", optimize=True)
    outputs.linux_icon_32.parent.mkdir(parents=True, exist_ok=True)
    color_symbol_32.save(outputs.linux_icon_32, format="PNG", optimize=True)
    outputs.windows_tile_30.parent.mkdir(parents=True, exist_ok=True)
    render_skill_core_symbol(30, monochrome=False).save(
        outputs.windows_tile_30, format="PNG", optimize=True
    )
    replace_small_windows_icon_frames(outputs.windows_icon)
    if patch_macos_bundle:
        replace_small_macos_icon_frames(outputs.macos_icon)
    print(f"已写入 {outputs.symbol_source}，尺寸=1024")
    print(f"已写入 {outputs.public_icon}，尺寸=32")
    print(f"已写入 {outputs.linux_icon_32}，尺寸=32")
    print(f"已写入 {outputs.windows_tile_30}，尺寸=30")
    print(f"已写入 {outputs.windows_icon} 的混合小尺寸帧")
    if patch_macos_bundle:
        print(f"已写入 {outputs.macos_icon} 的混合小尺寸帧")

    for size in SIZES:
        monochrome_output = outputs.tray_dir / f"tray-icon-{size}.png"
        color_output = outputs.tray_dir / f"tray-icon-color-{size}.png"
        render_skill_core_symbol(size, monochrome=True).save(
            monochrome_output, format="PNG", optimize=True
        )
        render_skill_core_symbol(size, monochrome=False).save(
            color_output, format="PNG", optimize=True
        )
        print(f"已写入 {monochrome_output}，尺寸={size}")
        print(f"已写入 {color_output}，尺寸={size}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=TRAY_DIR)
    parser.add_argument("--public-icon", type=Path, default=PUBLIC_ICON)
    parser.add_argument("--symbol-output", type=Path, default=SYMBOL_OUTPUT)
    parser.add_argument("--bundle-icon-32", type=Path, default=BUNDLE_ICON_32)
    parser.add_argument("--windows-tile-30", type=Path, default=WINDOWS_TILE_30)
    parser.add_argument("--ico-output", type=Path, default=ICO_OUTPUT)
    parser.add_argument("--icns-output", type=Path, default=ICNS_OUTPUT)
    parser.add_argument("--skip-icns", action="store_true")
    args = parser.parse_args()
    main(
        IconBuildOutputs(
            tray_dir=args.output_dir,
            public_icon=args.public_icon,
            symbol_source=args.symbol_output,
            linux_icon_32=args.bundle_icon_32,
            windows_tile_30=args.windows_tile_30,
            windows_icon=args.ico_output,
            macos_icon=args.icns_output,
        ),
        patch_macos_bundle=not args.skip_icns,
    )
