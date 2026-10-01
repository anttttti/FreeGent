const fs = require("fs");
fs.copyFileSync("enc/blob.bin", "c.bin");
fs.copyFileSync("enc/latin1.txt", "c-latin1.txt");
fs.renameSync("enc/bom.txt", "moved-bom.txt");
