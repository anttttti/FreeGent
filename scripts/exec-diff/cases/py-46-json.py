import json
json.dump({"k": "ä", "n": [1, 2]}, open("o.json", "w"), ensure_ascii=False)
print(json.load(open("data.json"))[0])
