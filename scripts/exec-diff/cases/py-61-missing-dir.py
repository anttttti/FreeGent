import errno
try:
    open("nodir/x.txt", "w")
except OSError as e:
    print(type(e).__name__, e.errno == errno.ENOENT)
