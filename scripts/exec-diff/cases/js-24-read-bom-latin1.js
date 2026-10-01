const fs = require("fs");
console.log(JSON.stringify(fs.readFileSync("enc/bom.txt", "utf8").slice(0, 5)));
console.log([...fs.readFileSync("enc/latin1.txt")].join(","));
console.log(fs.readFileSync("enc/latin1.txt", "latin1"));
