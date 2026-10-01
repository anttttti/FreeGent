const fs = require("fs");
for (const f of ["enc/utf8.txt", "enc/blob.bin", "enc/latin1.txt", "enc/bom.txt"]) console.log(f, fs.statSync(f).size);
