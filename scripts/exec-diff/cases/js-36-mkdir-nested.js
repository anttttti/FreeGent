const fs = require("fs");
fs.mkdirSync("new/dir", { recursive: true });
fs.writeFileSync("new/dir/f.txt", "deep\n");
