"""Synthetic training-data generator for the local command-segmentation tagger.

Every example is built from a template, so every token's tag is known exactly
at generation time -- no manual labeling. Text is generated already in the
same normalized form the real app parses (lowercase, no punctuation), matching
lib/combat/fuzzy.ts's normalize().

Tags: O, ACTION, TARGET, MOVE, DIR
"""
import json
import random
import re

random.seed(7)

VOCAB = json.load(open("tools/nlu/vocab.json"))

MOVE_VERBS = [
    "move", "approach", "advance", "charge", "go", "walk", "run", "flee",
    "retreat", "withdraw", "back away", "fall back", "close the distance",
    "close in", "reposition",
]
DIR_WORDS = ["back", "away", "toward", "towards"]
CONNECTIVES = ["then", "and"]
AT_PREPS = ["at", "on", "against", "toward", "towards"]
FILLER_PREFIXES = [
    "", "", "", "um ", "ok ", "okay ", "alright ", "let's ", "i want to ",
    "please ", "go ahead and ", "i guess i'll ", "can you ", "let's have ",
]
CAST_VERBS = ["cast", "use"]
DESCRIPTORS = [
    "the closest", "the nearest", "the weakest", "the wounded", "the injured",
    "the lowest hp", "that", "this", "the other", "the big",
]
SELF_WORDS = ["myself", "self", "me"]
INFO_PHRASES = [
    "actions", "options", "spells", "what can i do", "resources", "ki left",
    "slots", "what are my options", "show me my options", "what do i have",
    "list my actions", "my spells",
]

NOISE_SUBS = [("ph", "f"), ("c", "k"), ("qu", "kw"), ("x", "z"), ("ll", "l")]


def normalize(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def noisy(word: str, p: float = 0.12) -> str:
    """typo/mishearing noise: char drop, char dup, or a phonetic-ish substitution"""
    if random.random() > p or len(word) < 4:
        return word
    kind = random.choice(["drop", "dup", "sub"])
    i = random.randrange(len(word))
    if kind == "drop":
        return word[:i] + word[i + 1:]
    if kind == "dup":
        return word[:i] + word[i] + word[i:]
    for a, b in random.sample(NOISE_SUBS, len(NOISE_SUBS)):
        if a in word:
            return word.replace(a, b, 1)
    return word


def unit_ref(base_name: str) -> str:
    # "the" is never part of the name itself -- it's added (tagged O)
    # separately by add_target_phrase, so the TARGET span never includes it.
    base = normalize(base_name)
    n = random.randint(1, 6)
    if random.random() < 0.65:
        return f"{base} {n}"
    return base


def maybe_noise(text: str) -> str:
    words = text.split(" ")
    return " ".join(noisy(w) for w in words)


class Example:
    def __init__(self):
        self.tokens: list[str] = []
        self.tags: list[str] = []

    def add(self, text: str, tag: str):
        for w in normalize(text).split(" "):
            if not w:
                continue
            self.tokens.append(w)
            self.tags.append(tag)

    def as_dict(self):
        return {"tokens": self.tokens, "tags": self.tags}


def pick_action(pool):
    return random.choice(pool)


def pick_target():
    names = VOCAB["monsterNames"] + ["fighter", "rogue", "cleric", "druid", "sorcerer", "wizard", "monk", "bront", "sly", "ada", "dax", "cyra"]
    return unit_ref(random.choice(names))


def add_target_phrase(ex, p_descriptor=0.2, p_the=0.35, p_self=0.1):
    """adds a target reference to `ex` -- sometimes with a leading "the" or a
    fuller descriptor (both O), sometimes a bare self-reference (O, no
    TARGET span at all). "the" is always its own O token, never baked into
    the TARGET string, so the span boundary is unambiguous in training."""
    r = random.random()
    if r < p_self:
        ex.add(random.choice(SELF_WORDS), "O")
        return
    if r < p_self + p_descriptor:
        ex.add(random.choice(DESCRIPTORS), "O")
    elif r < p_self + p_descriptor + p_the:
        ex.add("the", "O")
    ex.add(maybe_noise(pick_target()), "TARGET")


TEMPLATES = []


def register(fn):
    TEMPLATES.append(fn)
    return fn


@register
def t_simple_attack(ex):
    filler = random.choice(FILLER_PREFIXES)
    if filler:
        ex.add(filler, "O")
    verb = random.choice(["attack", "hit", "strike"])
    ex.add(verb, "ACTION")
    prep = random.choice(AT_PREPS + [""])
    if prep:
        ex.add(prep, "O")
    else:
        ex.add("the", "O") if random.random() < 0.3 else None
    add_target_phrase(ex)


@register
def t_named_action_at_target(ex):
    filler = random.choice(FILLER_PREFIXES)
    if filler:
        ex.add(filler, "O")
    action = pick_action(VOCAB["pcActionNames"])
    if random.random() < 0.3:
        ex.add(random.choice(CAST_VERBS), "O")
    ex.add(maybe_noise(action), "ACTION")
    prep = random.choice(AT_PREPS)
    ex.add(prep, "O")
    add_target_phrase(ex)


@register
def t_action_no_target(ex):
    action = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(action), "ACTION")


@register
def t_move_then_action(ex):
    mv = random.choice(MOVE_VERBS)
    ex.add(mv, "MOVE")
    if random.random() < 0.6:
        ex.add(random.choice(["toward", "to", "at"]), "O")
        add_target_phrase(ex)
    ex.add(random.choice(CONNECTIVES), "O")
    action = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(action), "ACTION")
    if random.random() < 0.7:
        ex.add(random.choice(AT_PREPS), "O")
        add_target_phrase(ex)


@register
def t_dir_then_action(ex):
    # the exact failure pattern from the real transcript: "misty step back,
    # then fire bolt at owlbear 1"
    action1 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(action1), "ACTION")
    ex.add(random.choice(DIR_WORDS), "DIR")
    ex.add(random.choice(CONNECTIVES), "O")
    action2 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(action2), "ACTION")
    ex.add(random.choice(AT_PREPS), "O")
    add_target_phrase(ex)


@register
def t_action_then_bonus(ex):
    a1 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(a1), "ACTION")
    ex.add(random.choice(AT_PREPS), "O")
    add_target_phrase(ex)
    ex.add(random.choice(CONNECTIVES), "O")
    a2 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(a2), "ACTION")
    if random.random() < 0.5:
        ex.add(random.choice(AT_PREPS), "O")
        add_target_phrase(ex)


@register
def t_bonus_no_target_after_main(ex):
    # "multiattack at owlbear 2 then action surge" -- the bonus action has NO
    # target phrase of its own; the real bug was this getting misread
    a1 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(a1), "ACTION")
    ex.add(random.choice(AT_PREPS), "O")
    add_target_phrase(ex)
    ex.add(random.choice(CONNECTIVES), "O")
    a2 = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(a2), "ACTION")


@register
def t_multi_target_buff(ex):
    # "bless at monk 5, druid 5, rogue 5" (comma becomes a space after
    # normalize, so this looks the same as space-separated names)
    action = random.choice(["bless", "healing word", "mass healing word", "aid"])
    ex.add(action, "ACTION")
    ex.add(random.choice(AT_PREPS), "O")
    n = random.randint(2, 3)
    for i in range(n):
        add_target_phrase(ex)


@register
def t_hold_undo(ex):
    ex.add(random.choice(["hold", "pass", "wait", "skip my turn", "end turn", "undo", "nothing"]), "O")


@register
def t_retreat_bare(ex):
    ex.add(random.choice(["retreat", "fall back", "back away", "withdraw"]), "MOVE")
    if random.random() < 0.4:
        ex.add(random.choice(["from", "away from"]), "O")
        add_target_phrase(ex)


@register
def t_info_query(ex):
    ex.add(random.choice(INFO_PHRASES), "O")


@register
def t_describe_action(ex):
    ex.add("describe", "O")
    ex.add(maybe_noise(pick_action(VOCAB["pcActionNames"])), "ACTION")


@register
def t_action_on_self(ex):
    action = pick_action(VOCAB["pcActionNames"])
    ex.add(maybe_noise(action), "ACTION")
    ex.add(random.choice(AT_PREPS), "O")
    ex.add(random.choice(SELF_WORDS), "O")


def gen_example() -> Example:
    ex = Example()
    random.choice(TEMPLATES)(ex)
    return ex


def main(n_train=6000, n_eval=1200):
    with open("tools/nlu/data/train.jsonl", "w") as f:
        for _ in range(n_train):
            f.write(json.dumps(gen_example().as_dict()) + "\n")
    with open("tools/nlu/data/eval.jsonl", "w") as f:
        for _ in range(n_eval):
            f.write(json.dumps(gen_example().as_dict()) + "\n")
    print(f"wrote {n_train} train, {n_eval} eval examples")


if __name__ == "__main__":
    main()
