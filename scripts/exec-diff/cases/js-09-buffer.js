console.log(Buffer.from("é").toString("hex"), Buffer.from("hi").toString("base64"));
console.log(Buffer.from("aGk=", "base64").toString());
console.log(Buffer.byteLength("ä😀"));
