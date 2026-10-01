import csv
with open("out.csv", "w", newline="") as f:
    csv.writer(f).writerows([["a", "b"], ["ä", "1,2"]])
print(open("out.csv", "rb").read())
