"""Feature hashing shared by train/eval. Deliberately simple (word identity,
char trigrams, a few closed-class word sets) so the trained weights can be
reimplemented as a ~50-line TS forward pass with no ML runtime dependency.

FNV-1a is used (not Python's hash()) because it must produce the exact same
bucket assignments when ported to TypeScript -- Python's str hash is salted
per-process and isn't portable.
"""
import json

DIM = 4096  # feature-hashing buckets
TAGS = ["O", "ACTION", "TARGET", "MOVE", "DIR"]

_vocab = json.load(open("tools/nlu/vocab.json"))
MOVE_VERB_WORDS = set(
    w
    for phrase in [
        "move", "approach", "advance", "charge", "go", "walk", "run", "flee",
        "retreat", "withdraw", "back away", "fall back", "close the distance",
        "close in", "reposition",
    ]
    for w in phrase.split(" ")
)
DIR_WORDS = {"back", "away", "toward", "towards"}
CONNECTIVES = {"then", "and"}
PREPS = {"at", "on", "against", "toward", "towards", "the", "from"}


def _entity_words():
    words = set()
    for key in ("monsterNames", "spellNames", "pcActionNames"):
        for name in _vocab[key]:
            for w in name.lower().split(" "):
                w = "".join(c for c in w if c.isalnum())
                if w:
                    words.add(w)
    return words


ENTITY_WORDS = _entity_words()


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def bucket(feature: str) -> int:
    return fnv1a(feature) % DIM


def token_features(tokens: list[str], i: int) -> list[int]:
    """active feature-hash buckets for tokens[i], given its context."""
    tok = tokens[i]
    prev = tokens[i - 1] if i > 0 else "<bos>"
    nxt = tokens[i + 1] if i + 1 < len(tokens) else "<eos>"
    feats = [f"w:{tok}", f"w-1:{prev}", f"w+1:{nxt}"]

    padded = f"^{tok}$"
    for j in range(len(padded) - 2):
        feats.append(f"c:{padded[j:j + 3]}")

    if tok.isdigit():
        feats.append("isdigit")
    feats.append(f"len:{min(len(tok), 6)}")
    if tok in CONNECTIVES:
        feats.append("conn")
    if tok in PREPS:
        feats.append("prep")
    if tok in MOVE_VERB_WORDS:
        feats.append("movew")
    if tok in DIR_WORDS:
        feats.append("dirw")
    if tok in ENTITY_WORDS:
        feats.append("entw")
    if prev in ENTITY_WORDS:
        feats.append("entw-1")
    if nxt in ENTITY_WORDS:
        feats.append("entw+1")

    return [bucket(f) for f in feats]
