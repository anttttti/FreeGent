/* WASI preview 1 has no process cwd. Initialize wasi-libc's cwd from the host's
 * authoritative PWD, using one root preopen so absolute paths stay absolute.
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void initialize_cwd(void) {
  const char *cwd = getenv("PWD");
  if (cwd && chdir(cwd)) { perror("WASI cwd"); exit(1); }
}
