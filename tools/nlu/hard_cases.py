"""Hand-labeled real/adversarial phrasings -- not drawn from generate_data.py's
templates. Includes the exact sentences that broke the regex parser this
session, plus colloquial phrasings a real player might actually type/say.
Each entry: (tokens, tags) already aligned 1:1.
"""

CASES = [
    # the exact real bug: "back" scored 0.5 against the Weapon action's id
    # "attack" and stole the whole clause before "Misty Step" was tried
    (
        "misty step back then fire bolt at owlbear 1".split(),
        ["ACTION", "ACTION", "DIR", "O", "ACTION", "ACTION", "O", "TARGET", "TARGET"],
    ),
    # the exact real bug: bonus action with no target of its own re-asked
    # "on who?" instead of reusing the main target
    (
        "multiattack at owlbear 2 then action surge".split(),
        ["ACTION", "O", "TARGET", "TARGET", "O", "ACTION", "ACTION"],
    ),
    # the exact real bug: 3 comma-separated names read as one ambiguous ref
    (
        "bless at monk 5 druid 5 rogue 5".split(),
        ["ACTION", "O", "TARGET", "TARGET", "TARGET", "TARGET", "TARGET", "TARGET"],
    ),
    (
        "spike growth at kobold 1".split(),
        ["ACTION", "ACTION", "O", "TARGET", "TARGET"],
    ),
    # "closest" isn't in any template -- generalization test
    (
        "attack the closest kobold".split(),
        ["ACTION", "O", "O", "TARGET"],
    ),
    (
        "i ll cast fireball on the dragon".split(),
        ["O", "O", "O", "ACTION", "O", "O", "TARGET"],
    ),
    # very colloquial -- "hit it with my axe" instead of a named action
    (
        "move toward the troll and then hit it with my axe".split(),
        ["MOVE", "O", "O", "TARGET", "O", "O", "ACTION", "O", "O", "O", "O"],
    ),
    (
        "charge the goblin then flurry of blows".split(),
        ["MOVE", "O", "TARGET", "O", "ACTION", "ACTION", "ACTION"],
    ),
    (
        "back away from the ogre".split(),
        ["MOVE", "MOVE", "O", "O", "TARGET"],
    ),
    (
        "can you have the rogue sneak attack the wounded goblin".split(),
        ["O", "O", "O", "O", "TARGET", "O", "ACTION", "O", "O", "TARGET"],
    ),
    ("hold".split(), ["O"]),
    ("undo that".split(), ["O", "O"]),
    ("what are my options".split(), ["O", "O", "O", "O"]),
    ("describe fireball".split(), ["O", "ACTION"]),
    (
        "cure wounds on bront".split(),
        ["ACTION", "ACTION", "O", "TARGET"],
    ),
    (
        "healing word 2nd on myself".split(),
        ["ACTION", "ACTION", "ACTION", "O", "O"],
    ),
    (
        "attack goblin 1 then cast shield".split(),
        ["ACTION", "TARGET", "TARGET", "O", "O", "ACTION"],
    ),
    ("retreat".split(), ["MOVE"]),
    (
        "go attack the dragon".split(),
        ["O", "ACTION", "O", "TARGET"],
    ),
    (
        "flurry of blows then attack".split(),
        ["ACTION", "ACTION", "ACTION", "O", "ACTION"],
    ),
]
