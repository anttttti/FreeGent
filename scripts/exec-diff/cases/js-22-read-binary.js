const fs = require("fs");
const b = fs.readFileSync("enc/blob.bin");
console.log(b.length, b[0], b[255], b[256]);
