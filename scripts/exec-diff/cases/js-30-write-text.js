const fs = require("fs");
fs.writeFileSync("n1.txt", "a\r\nb\n");
fs.writeFileSync("n3.txt", "ä😀\n");
fs.writeFileSync("ñandú.txt", "ok\n");
