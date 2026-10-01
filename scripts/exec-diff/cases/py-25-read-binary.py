import hashlib
d = open("enc/blob.bin", "rb").read()
print(len(d), hashlib.sha256(d).hexdigest())
