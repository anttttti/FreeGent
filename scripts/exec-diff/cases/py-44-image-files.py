open("img.png", "wb").write(b"\x89PNG\r\n\x1a\n" + bytes(range(40)))
open("pic.svg", "w").write('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
