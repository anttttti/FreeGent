import os
os.makedirs("d", exist_ok=True)
open("./p1.txt", "w").write("1\n")
open("d//f.txt", "w").write("2\n")
open("d/./g.txt", "w").write("3\n")
open("d/../h.txt", "w").write("4\n")
open(os.path.join(os.getcwd(), "abs.txt"), "w").write("5\n")
print(sorted(os.listdir("d")))
