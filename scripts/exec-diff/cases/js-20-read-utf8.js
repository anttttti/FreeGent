const fs = require("fs");
const t = fs.readFileSync("enc/utf8.txt", "utf8");
console.log(t.length, JSON.stringify(t.split("\n")[3]));
