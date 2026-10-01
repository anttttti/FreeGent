const fs = require("fs/promises");
await fs.writeFile("pr.txt", "async\n");
console.log((await fs.readFile("pr.txt", "utf8")).trim());
