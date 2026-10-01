const fs = require("fs");
fs.renameSync("words.txt", "src/words.txt");
try { fs.renameSync("nums.txt", "nodir/nums.txt"); } catch (e) { console.log(e.code); }
console.log(fs.readdirSync("src"));
