import shutil
shutil.copytree("src", "src2")
shutil.move("src2/app.js", "moved.js")
shutil.rmtree("dir")
