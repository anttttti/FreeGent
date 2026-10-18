export class ProcessExitError extends Error {
  // @ts-ignore -- Error.code is string in @types/node; we use number here
  declare code: number;
  _isProcessExit = true;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}
