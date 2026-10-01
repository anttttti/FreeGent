import sys
print(sys.path[0] == "")
import string, types
print(string.__file__.endswith("string.py"), "workspace" not in (types.__file__ or ""))
