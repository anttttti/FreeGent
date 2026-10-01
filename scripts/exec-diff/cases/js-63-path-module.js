const path = require("path");
console.log(path.join("a", "../b", "./c/"), path.normalize("a//b/../c/."), path.basename("/x/y.txt", ".txt"), path.dirname("a/b/c"), path.extname("f.tar.gz"));
console.log(path.relative(process.cwd(), path.resolve("src/lib")), path.isAbsolute("/a"), path.resolve("a/../b") === path.join(process.cwd(), "b"));
