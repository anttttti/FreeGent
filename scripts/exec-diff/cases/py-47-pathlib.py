from pathlib import Path
Path("p.txt").write_text("päth\n")
Path("p.bin").write_bytes(b"\x00\x01")
print(Path("enc/utf8.txt").read_text().splitlines()[2])
