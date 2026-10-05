/* GNU C-locale diagnostics for upstream CLIs built with wasi-libc.
 * Measured against native glibc and wasi-sdk 27 strerror for all named errnos.
 * Keep this in libc glue: program byte streams are never rewritten.
 * SPDX-License-Identifier: MIT
 */
#include <errno.h>
#include <string.h>
extern char *__real_strerror(int code);
char *__wrap_strerror(int code) {
    switch(code) {
    case EADDRINUSE: return "Address already in use";
    case EADDRNOTAVAIL: return "Cannot assign requested address";
    case EBUSY: return "Device or resource busy";
    case ECHILD: return "No child processes";
    case ECONNABORTED: return "Software caused connection abort";
    case EDEADLK: return "Resource deadlock avoided";
    case EDOM: return "Numerical argument out of domain";
    case EDQUOT: return "Disk quota exceeded";
    case EHOSTUNREACH: return "No route to host";
    case EILSEQ: return "Invalid or incomplete multibyte or wide character";
    case EINPROGRESS: return "Operation now in progress";
    case EIO: return "Input/output error";
    case EISCONN: return "Transport endpoint is already connected";
    case ELOOP: return "Too many levels of symbolic links";
    case EMFILE: return "Too many open files";
    case EMSGSIZE: return "Message too long";
    case ENAMETOOLONG: return "File name too long";
    case ENETRESET: return "Network dropped connection on reset";
    case ENETUNREACH: return "Network is unreachable";
    case ENOMEM: return "Cannot allocate memory";
    case ENOTCONN: return "Transport endpoint is not connected";
    case ENOTSOCK: return "Socket operation on non-socket";
    case ENOTSUP: return "Operation not supported";
    case ENOTTY: return "Inappropriate ioctl for device";
    case EOVERFLOW: return "Value too large for defined data type";
    case EOWNERDEAD: return "Owner died";
    case ERANGE: return "Numerical result out of range";
    case ESPIPE: return "Illegal seek";
    case ETIMEDOUT: return "Connection timed out";
    case EXDEV: return "Invalid cross-device link";
    default: return __real_strerror(code);
    }
}
