import os
for root, dirs, files in sorted(os.walk(".")):
    print(root, sorted(dirs), sorted(files))
