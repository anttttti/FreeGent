const fs = require("fs");
fs.appendFileSync("words.txt", "zebra\n");
fs.appendFileSync("enc/crlf.txt", "more\r\n");
