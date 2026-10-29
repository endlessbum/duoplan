from pathlib import Path

from PIL import Image


def test_og_image_has_declared_dimensions():
    with Image.open(Path("public/og.png")) as image:
        assert image.size == (1200, 630)


