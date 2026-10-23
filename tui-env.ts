// Imported first by fg-tui.tsx. React's development build records a performance.measure() for every component render, and
// Node keeps every one of them (with the old and new props it compared) until they are cleared. In a long session that is
// millions of entries holding earlier transcript text: a 2.4 h review grew to a 4 GB heap, the interface was held up for
// seconds at a time, and the process died out of memory. The production build records none, and is faster.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
export {};
