const fs = require("fs");
try { fs.writeFileSync("nodir/x.txt", "x"); } catch (e) { console.log(e.code); }
try { fs.appendFileSync("nodir/y.txt", "y"); } catch (e) { console.log(e.code); }
