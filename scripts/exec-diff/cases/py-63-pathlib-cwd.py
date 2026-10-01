from pathlib import Path
(Path.cwd() / "pc.txt").write_text("p\n")
print(Path("src/lib/helper.py").resolve().relative_to(Path.cwd()))
print(Path("src/../src/./lib").resolve().relative_to(Path.cwd()))
