const fs = require("fs");
fs.writeFileSync("n2.bin", Buffer.from([0, 255, 128]));
fs.writeFileSync("n2b.bin", new Uint8Array([1, 2, 3, 200]));
