"""Trains a small per-token softmax classifier (feature hashing -> linear ->
softmax over 5 tags) with plain SGD. No sklearn/pytorch -- numpy only, so the
trained weights (a [DIM x 5] matrix + bias) port trivially to a TS forward
pass with zero new runtime dependencies.
"""
import json
import random

import numpy as np

from features import DIM, TAGS, token_features

random.seed(7)
np.random.seed(7)

TAG_IDX = {t: i for i, t in enumerate(TAGS)}


def load(path):
    examples = []
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            examples.append((d["tokens"], d["tags"]))
    return examples


def softmax(z):
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def predict_token(W, b, feats):
    z = b.copy()
    for f in feats:
        z += W[f]
    return z


def train(train_path, eval_path, epochs=6, lr=0.5, l2=1e-6):
    train_ex = load(train_path)
    eval_ex = load(eval_path)

    W = np.zeros((DIM, len(TAGS)), dtype=np.float64)
    b = np.zeros(len(TAGS), dtype=np.float64)

    # pre-extract features once (cheap: a few thousand short sentences)
    train_data = []
    for tokens, tags in train_ex:
        for i in range(len(tokens)):
            feats = token_features(tokens, i)
            train_data.append((feats, TAG_IDX[tags[i]]))

    n = len(train_data)
    print(f"training on {n} tokens from {len(train_ex)} sentences")

    for epoch in range(epochs):
        random.shuffle(train_data)
        total_loss = 0.0
        for feats, y in train_data:
            z = predict_token(W, b, feats)
            p = softmax(z)
            total_loss += -np.log(max(p[y], 1e-12))
            grad = p.copy()
            grad[y] -= 1.0
            for f in feats:
                W[f] -= lr * (grad + l2 * W[f])
            b -= lr * grad
        acc = evaluate(W, b, eval_ex)
        print(f"epoch {epoch + 1}: loss={total_loss / n:.4f} eval_token_acc={acc:.4f}")

    return W, b


def evaluate(W, b, examples):
    correct = 0
    total = 0
    for tokens, tags in examples:
        for i in range(len(tokens)):
            feats = token_features(tokens, i)
            z = predict_token(W, b, feats)
            pred = TAGS[int(np.argmax(z))]
            if pred == tags[i]:
                correct += 1
            total += 1
    return correct / total


def span_accuracy(W, b, examples):
    """stricter metric: did we get every token in the sentence exactly right?"""
    exact = 0
    for tokens, tags in examples:
        preds = []
        for i in range(len(tokens)):
            feats = token_features(tokens, i)
            z = predict_token(W, b, feats)
            preds.append(TAGS[int(np.argmax(z))])
        if preds == tags:
            exact += 1
    return exact / len(examples)


if __name__ == "__main__":
    W, b = train("tools/nlu/data/train.jsonl", "tools/nlu/data/eval.jsonl")
    eval_ex = load("tools/nlu/data/eval.jsonl")
    print(f"final eval token accuracy: {evaluate(W, b, eval_ex):.4f}")
    print(f"final eval EXACT-sentence accuracy: {span_accuracy(W, b, eval_ex):.4f}")

    weights = {
        "dim": DIM,
        "tags": TAGS,
        "W": W.tolist(),
        "b": b.tolist(),
    }
    with open("tools/nlu/weights.json", "w") as f:
        json.dump(weights, f)
    print("wrote tools/nlu/weights.json")
