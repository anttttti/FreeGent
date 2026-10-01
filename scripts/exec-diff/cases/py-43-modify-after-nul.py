d = bytearray(open("enc/blob.bin", "rb").read())
d[-1] ^= 1
open("enc/blob.bin", "wb").write(d)
