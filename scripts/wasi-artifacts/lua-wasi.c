/* Platform glue for upstream Lua: temporary files and an explicit process boundary.
 * Lua's parser, VM, libraries and CLI remain upstream. SPDX-License-Identifier: MIT
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <wasi/api.h>

int shiro_lua_tmpname(char *name) {
  static const char alphabet[] = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (int attempt = 0; attempt < 128; attempt++) {
    unsigned char random[6];
    __wasi_errno_t error = __wasi_random_get(random, sizeof random);
    if (error) { errno = error; return -1; }
    strcpy(name, "/tmp/lua_");
    for (int i = 0; i < 6; i++) name[9 + i] = alphabet[random[i] % 36];
    name[15] = '\0';
    int fd = open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  errno = EEXIST;
  return -1;
}

FILE *tmpfile(void) {
  char name[32];
  int fd = shiro_lua_tmpname(name);
  if (fd < 0) return NULL;
  FILE *file = fdopen(fd, "w+");
  int saved = errno;
  unlink(name);
  if (!file) close(fd);
  errno = saved;
  return file;
}
