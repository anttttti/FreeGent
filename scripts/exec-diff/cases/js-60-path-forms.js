const fs = require("fs"), path = require("path");
fs.mkdirSync("d");
fs.writeFileSync("./p1.txt", "1\n");
fs.writeFileSync("d//f.txt", "2\n");
fs.writeFileSync("d/./g.txt", "3\n");
fs.writeFileSync("d/../h.txt", "4\n");
fs.writeFileSync(path.join(process.cwd(), "abs.txt"), "5\n");
console.log(fs.readdirSync("d"));
