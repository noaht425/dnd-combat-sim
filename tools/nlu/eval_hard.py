import json

import numpy as np

from features import TAGS, token_features
from hard_cases import CASES

weights = json.load(open("tools/nlu/weights.json"))
W = np.array(weights["W"])
b = np.array(weights["b"])


def predict(tokens):
    preds = []
    for i in range(len(tokens)):
        feats = token_features(tokens, i)
        z = b.copy()
        for f in feats:
            z += W[f]
        preds.append(TAGS[int(np.argmax(z))])
    return preds


exact = 0
tok_correct = 0
tok_total = 0
for tokens, gold in CASES:
    pred = predict(tokens)
    ok = pred == gold
    exact += ok
    for p, g in zip(pred, gold):
        tok_correct += p == g
        tok_total += 1
    marker = "OK  " if ok else "MISS"
    print(f"{marker} {' '.join(tokens)}")
    if not ok:
        print(f"     gold: {gold}")
        print(f"     pred: {pred}")

print(f"\n{exact}/{len(CASES)} sentences exact, token acc {tok_correct}/{tok_total} = {tok_correct/tok_total:.3f}")
