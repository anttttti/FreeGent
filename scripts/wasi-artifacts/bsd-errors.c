// BSD err.h diagnostics omitted from wasi-libc, using its authoritative argv name.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void warn(const char *format, ...) {
    int saved_errno = errno;
    fprintf(stderr, "%s: ", program_invocation_short_name);
    if (format) {
        va_list args;
        va_start(args, format);
        vfprintf(stderr, format, args);
        va_end(args);
        fputs(": ", stderr);
    }
    fprintf(stderr, "%s\n", strerror(saved_errno));
}

_Noreturn void errx(int status, const char *format, ...) {
    fprintf(stderr, "%s: ", program_invocation_short_name);
    if (format) {
        va_list args;
        va_start(args, format);
        vfprintf(stderr, format, args);
        va_end(args);
    }
    fputc('\n', stderr);
    exit(status);
}

// Additional err.h entrypoints required by util-linux. Keep cal's build unchanged.
#ifdef WASI_BSD_EXTENDED
void warnx(const char *format, ...) {
    va_list args;
    va_start(args, format);
    fprintf(stderr, "%s: ", program_invocation_short_name);
    if (format) vfprintf(stderr, format, args);
    fputc('\n', stderr);
    va_end(args);
}

_Noreturn void err(int status, const char *format, ...) {
    int saved_errno = errno;
    va_list args;
    va_start(args, format);
    fprintf(stderr, "%s: ", program_invocation_short_name);
    if (format) { vfprintf(stderr, format, args); fputs(": ", stderr); }
    fprintf(stderr, "%s\n", strerror(saved_errno));
    va_end(args);
    exit(status);
}
#endif
