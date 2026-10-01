const fs = require("fs");
console.log(JSON.stringify(fs.readFileSync("enc/crlf.txt", "utf8")));
console.log(JSON.stringify(fs.readFileSync("enc/mixed-eol.txt", "utf8")));
