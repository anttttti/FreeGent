const fs = require("fs");
fs.writeFileSync("u.txt", fs.readFileSync("enc/utf8.txt"));
fs.writeFileSync("b.txt", fs.readFileSync("enc/bom.txt"));
