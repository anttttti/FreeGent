import glob
print(sorted(glob.glob("**/*.py", recursive=True)))
print(sorted(glob.glob("./src/*.js")))
