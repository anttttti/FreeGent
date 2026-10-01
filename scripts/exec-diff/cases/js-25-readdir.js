const fs = require("fs");
console.log(fs.readdirSync("enc"));
console.log(fs.existsSync("enc/utf8.txt"), fs.existsSync("nope"));
