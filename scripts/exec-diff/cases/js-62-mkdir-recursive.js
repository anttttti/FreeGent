const fs = require("fs");
fs.mkdirSync("a/b/c", { recursive: true });
fs.writeFileSync("a/b/c/f.txt", "deep\n");
console.log(fs.readdirSync("a/b"), fs.existsSync("a/b/c"), fs.statSync("a/b").isDirectory());
