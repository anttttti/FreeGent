/* wasi-libc omits dup; implemented using the existing WASIX descriptor capability.
 * SPDX-License-Identifier: MIT
 */
int dup(int fd);
