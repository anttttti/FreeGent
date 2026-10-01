print(open("enc/crlf.txt", "rb").read())
print(repr(open("enc/crlf.txt", newline="").read()))
print(repr(open("enc/crlf.txt").read()))
