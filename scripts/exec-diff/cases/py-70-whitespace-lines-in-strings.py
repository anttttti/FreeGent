code = """def f():
    x = 1
    
    return x
"""
open("gen.py", "w").write(code)
print(repr(open("gen.py").read()))
