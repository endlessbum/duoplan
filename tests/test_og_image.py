from pathlib import Path

from PIL import Image


def test_og_image_has_declared_dimensions():
    with Image.open(Path("public/og.png")) as image:
        assert image.size == (1200, 630)


def test_og_image_is_not_a_copy_of_favicon():
    og = Path("public/og.png").read_bytes()
    favicon = Path("public/favicon.png").read_bytes()
    assert og != favicon
