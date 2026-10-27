import compileall
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
ok = compileall.compile_dir(str(root / "duoplan"), quiet=1, force=True)
print("COMPILED" if ok else "FAILED")
sys.exit(0 if ok else 1)
