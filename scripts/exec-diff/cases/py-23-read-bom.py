print(open("enc/bom.txt", "rb").read()[:4])
print(repr(open("enc/bom.txt", encoding="utf-8-sig").read()))
