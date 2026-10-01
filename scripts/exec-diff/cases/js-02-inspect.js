console.log([1, 2, { a: NaN }], new Map([["k", 1]]), -0, 10n, undefined, null);
console.log({ a: 1, b: "x", c: [1, 2, 3], d: { e: { f: { g: 1 } } } });
console.log(new Set([1, "a"]), [undefined, , 3], function f() {}, Symbol("s"));
console.log([Infinity, -Infinity, 1e21, 0.1 + 0.2], [new Date(0)]);
console.log(Array.from({ length: 30 }, (_, i) => i));
console.log("str", 42, true, [ "s" ]);
