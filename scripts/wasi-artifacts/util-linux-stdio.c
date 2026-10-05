/* Real descriptor duplication and closed-descriptor validation for wasi-libc.
 * SPDX-License-Identifier: MIT
 */
#include <errno.h>
__attribute__((import_module("wasix_32v1"),import_name("fd_dup")))
extern unsigned fd_dup(unsigned fd,unsigned *out);
int dup(int fd) { unsigned out; unsigned result=fd_dup(fd,&out); if(result) { errno=result; return -1; } return out; }
#include <stdio.h>
#include <wasi/api.h>
extern int __real_fileno(FILE *stream);
int __wrap_fileno(FILE *stream) {
    int fd=__real_fileno(stream);
    if(fd < 0) return fd;
    __wasi_fdstat_t stat;
    __wasi_errno_t result=__wasi_fd_fdstat_get(fd,&stat);
    if(result) { errno=result; return -1; }
    return fd;
}
