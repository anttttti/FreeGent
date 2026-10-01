import sys
sys.stdout.buffer.write(b"\xc3\xa9\n")
sys.stdout.flush()
print("after")
