import sys
print(repr(sys.stdin.read()))
try:
    input()
except EOFError:
    print("eof")
