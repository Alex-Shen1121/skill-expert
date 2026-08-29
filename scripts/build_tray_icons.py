"""生成系统状态区使用的技能核心符号图标体系。

角色 App 图标由 `icon-source.png` 和 `npx tauri icon` 独立生成；本脚本只负责 macOS
菜单栏以及 Windows、Linux 系统托盘，绝不改写任何应用身份图标。

用法：
    python scripts/build_tray_icons.py

输出：
    src-tauri/icons/skill-core-symbol.png                     （1024px 源图）
    src-tauri/icons/tray/tray-icon-{16,20,24,32}.png         （单色）
    src-tauri/icons/tray/tray-icon-color-{16,20,24,32}.png   （彩色）
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


REPO = Path(__file__).resolve().parent.parent
TRAY_DIR = REPO / "src-tauri" / "icons" / "tray"
SYMBOL_OUTPUT = REPO / "src-tauri" / "icons" / "skill-core-symbol.png"
SIZES = (16, 20, 24, 32)
SSAA = 8

INDIGO = (39, 29, 86, 255)
CYAN = (91, 231, 236, 255)
PINK = (255, 139, 196, 255)
WHITE = (255, 255, 255, 255)


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


def main(tray_dir: Path = TRAY_DIR, symbol_output: Path = SYMBOL_OUTPUT) -> None:
    tray_dir.mkdir(parents=True, exist_ok=True)
    symbol_output.parent.mkdir(parents=True, exist_ok=True)

    render_skill_core_symbol(1024, monochrome=False).save(
        symbol_output, format="PNG", optimize=True
    )
    print(f"已写入 {symbol_output}，尺寸=1024")

    for size in SIZES:
        monochrome_output = tray_dir / f"tray-icon-{size}.png"
        color_output = tray_dir / f"tray-icon-color-{size}.png"
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
    parser.add_argument("--symbol-output", type=Path, default=SYMBOL_OUTPUT)
    args = parser.parse_args()
    main(args.output_dir, args.symbol_output)
