/* WASI preview 1 has no subprocess API. Do not claim a command was executed.
 * SPDX-License-Identifier: MIT
 */
#include <errno.h>
int system(const char *command) {
  if (!command) return 0;
  errno = ENOSYS;
  return -1;
}
