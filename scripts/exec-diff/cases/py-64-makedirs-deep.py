import os
os.makedirs("a/b/c")
open("a/b/c/f.txt", "w").write("deep\n")
for r, d, f in sorted(os.walk("a")):
    print(r, sorted(d), sorted(f))
