import os
os.chdir("src")
open("here.txt", "w").write("h\n")
open("../up.txt", "w").write("u\n")
print(sorted(os.listdir(".")))
