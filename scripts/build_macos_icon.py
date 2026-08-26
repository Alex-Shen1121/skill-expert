"""从原始插画生成符合 macOS 规范的应用图标。

macOS Big Sur 及更高版本不再自动为 Dock 图标添加遮罩，因此应用必须自行提供圆角矩形。
本脚本在 1024x1024 画布上使用 824x824 的 Apple 标准连续圆角矩形
（G2 超椭圆，n=5）包裹插画，以匹配 macOS 应用图标制作模板。

用法：
    python scripts/build_macos_icon.py
    python scripts/build_macos_icon.py --source artwork.png --output icon.png
    # 然后重新生成全部 bundle 资产：
    npx tauri icon src-tauri/icons/icon.png

输入：
    src-tauri/icons/icon-source.png   满版方形插画；本脚本负责生成透明外角

输出：
    src-tauri/icons/icon.png          1024x1024 连续圆角矩形图标

可调参数：
    SQUIRCLE_N      超椭圆指数；约 5 时接近 Apple 连续圆角
    SSAA            遮罩的超采样抗锯齿倍数
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent
ICON_DIR = REPO / "src-tauri" / "icons"
SOURCE = ICON_DIR / "icon-source.png"
OUTPUT = ICON_DIR / "icon.png"

CANVAS = 1024
BODY = 824
SQUIRCLE_N = 5.0
SSAA = 8


def make_squircle_mask(size: int, n: float) -> Image.Image:
    """以向量化方式生成超椭圆遮罩，并通过超采样缩小实现抗锯齿。"""
    big = size * SSAA
    half = big / 2.0
    coords = (np.arange(big) - half + 0.5) / half
    xx, yy = np.meshgrid(coords, coords, indexing="xy")
    inside = (np.abs(xx) ** n + np.abs(yy) ** n) <= 1.0
    arr = inside.astype(np.uint8) * 255
    return Image.fromarray(arr, mode="L").resize((size, size), Image.LANCZOS)


def main(source: Path = SOURCE, output: Path = OUTPUT) -> None:
    if not source.exists():
        raise SystemExit(f"缺少源插画：{source}")

    src = Image.open(source).convert("RGBA")
    bbox = src.getbbox()
    if bbox:
        src = src.crop(bbox)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sq_mask = make_squircle_mask(BODY, SQUIRCLE_N)

    # 使用柔和阴影增加 Dock 图标的层次感。
    shadow_pad = 60
    shadow_layer = Image.new("RGBA", (BODY + shadow_pad * 2, BODY + shadow_pad * 2), (0, 0, 0, 0))
    shadow_alpha = Image.new("L", shadow_layer.size, 0)
    shadow_alpha.paste(sq_mask, (shadow_pad, shadow_pad))
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(radius=14))
    shadow_alpha = Image.eval(shadow_alpha, lambda v: int(v * 60 / 255))
    shadow_rgba = Image.new("RGBA", shadow_layer.size, (0, 0, 0, 255))
    shadow_rgba.putalpha(shadow_alpha)
    sx = (CANVAS - shadow_layer.size[0]) // 2
    sy = (CANVAS - shadow_layer.size[1]) // 2 + 6
    canvas.alpha_composite(shadow_rgba, (sx, sy))

    # 白色连续圆角矩形底板。
    body = Image.new("RGBA", (BODY, BODY), (255, 255, 255, 255))
    body.putalpha(sq_mask)
    qx = (CANVAS - BODY) // 2
    qy = (CANVAS - BODY) // 2
    canvas.alpha_composite(body, (qx, qy))

    # 将插画放入连续圆角矩形，并裁切到遮罩范围内。
    target = BODY
    sw, sh = src.size
    scale = min(target / sw, target / sh)
    new_size = (max(1, int(sw * scale)), max(1, int(sh * scale)))
    art = src.resize(new_size, Image.LANCZOS)

    art_layer = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    cx = (BODY - new_size[0]) // 2
    cy = (BODY - new_size[1]) // 2
    art_layer.alpha_composite(art, (cx, cy))

    art_alpha = np.array(art_layer.split()[3])
    mask_arr = np.array(sq_mask)
    art_layer.putalpha(Image.fromarray(np.minimum(art_alpha, mask_arr).astype(np.uint8), mode="L"))
    canvas.alpha_composite(art_layer, (qx, qy))

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)
    print(f"已写入 {output}，尺寸={canvas.size}")
    print("下一步：npx tauri icon src-tauri/icons/icon.png")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    main(args.source, args.output)
