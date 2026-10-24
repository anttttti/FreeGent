// task-policy.ts — FreeGent: the task policy a run can add on top of the product.
//
// A benchmark runner knows things an ordinary user's request does not: that the task is solved by editing
// files, that it is graded on the state of the system afterwards, which tests grade it, that edits to test
// files score zero. Those policies live in bench-policy.ts, which only the headless runner loads, and only
// when one of its FG_* switches is set. The product code asks here, and with nothing installed the answers
// are "no policy": no gate bounces a reply, no tool refuses a path, no test is graded.
//
// `installTaskPolicy` is how bench-policy.ts (and tests) plug in; `resetTaskPolicy` takes it out again.

export interface TaskPolicy {
    /** The task is solved by editing files: a COMPLETED with no edit is bounced once. */
    editRequired(): boolean;
    /** The task is graded on the system's state afterwards: a reply that changed nothing cannot be right. */
    changeRequired(): boolean;
    /** Test ids the runner lists in the task text. */
    gradedTestIds(task: string): string[];
    /** True when this test output shows a graded test that ran and failed. */
    gradedTestFailed(output: string, ids: string[]): boolean;
    /** A shell command that changes the machine without writing a file the tool layer reports. */
    changesState(code: string): boolean;
    /** Edits to this path score zero (the grader strips test-file changes). */
    isTestEditProtected(path: unknown): boolean;
    testEditRefusal(path: string): { error: string };
    /** Guidance text appended to the first COMPLETED when graded tests are listed (null: none). Marks `graded_test` as fired. */
    completionDirective(task: string, reactiveFired: Set<string>): string | null;
    /** A second COMPLETED after that directive: the bounce text when the graded test has not run or failed (null: let it pass). */
    retryDirective(history: any[], task: string): string | null;
}

const NO_POLICY: TaskPolicy = {
    editRequired: () => false,
    changeRequired: () => false,
    gradedTestIds: () => [],
    gradedTestFailed: () => false,
    changesState: () => false,
    isTestEditProtected: () => false,
    testEditRefusal: (path: string) => ({ error: `Editing ${path} is not allowed.` }),
    completionDirective: () => null,
    retryDirective: () => null,
};

export const taskPolicy: TaskPolicy = { ...NO_POLICY };

export function installTaskPolicy(p: Partial<TaskPolicy>): void { Object.assign(taskPolicy, p); }
export function resetTaskPolicy(): void { Object.assign(taskPolicy, NO_POLICY); }
