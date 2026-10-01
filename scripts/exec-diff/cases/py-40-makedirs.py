import os
os.makedirs("new/dir", exist_ok=True)
open("new/dir/f.txt", "w").write("deep\n")
