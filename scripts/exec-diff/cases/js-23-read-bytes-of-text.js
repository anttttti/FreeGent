const fs = require("fs");
const b = fs.readFileSync("enc/utf8.txt");
console.log(b.length, b.toString("hex").slice(0, 16), b.toString().split("\n").length);
