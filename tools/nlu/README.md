# Local command-parsing model

A small, fully local, zero-cost alternative to the old regex-based clause
splitter in `lib/combat/commandParser.ts`. No LLM, no network call, no
per-message cost — a ~180KB trained weights file (`lib/combat/nluWeights.json`)
and a ~150-line TypeScript forward pass (`lib/combat/nluModel.ts`).

## What it does

For each word in a normalized player command, predicts one of five tags:

- `O` — filler / connective ("then", "at", "the")
- `ACTION` — part of an action-name reference ("fire", "bolt")
- `TARGET` — part of a target-name reference ("owlbear", "1")
- `MOVE` — a movement verb ("retreat", "fall back")
- `DIR` — a bare direction that doesn't map to anything downstream ("back" in
  "misty step back") — its only job is *not* being absorbed into ACTION/TARGET

`commandParser.ts` groups same-tag runs into spans, pairs each MOVE/ACTION
with the TARGET span(s) immediately following it, and hands those spans to
the *existing* fuzzy candidate-matcher (`findBestAction`, `resolveTarget`) —
this model only replaces segmentation (which words mean what), not resolution
(which specific action/unit those words refer to). That part already worked
well because the candidate list is always fully known at parse time.

## Why

The old regex clause-splitter (`n.split(/\bthen\b|\band\b|,/)` + preposition
guessing) was a pile of hand-written heuristics that broke in specific,
findable ways — e.g. "misty step back" mis-split because "back" scored 0.5
against the Weapon action's internal id "attack" (coincidental string
similarity), stealing the whole clause before "Misty Step" was ever tried.
See the parent conversation for four other real examples.

## Pipeline

```
extract_vocab.test.ts   -- dumps real spell/monster/PC-action names from the
                            live game data -> vocab.json
generate_data.py        -- builds synthetic labeled sentences from vocab.json
                            + templates + injected typos -> data/train.jsonl,
                            data/eval.jsonl (gitignored, regenerate anytime)
features.py             -- feature hashing (FNV-1a -> 4096 buckets): word
                            identity, char trigrams, a few closed-class word
                            sets. Ported bucket-for-bucket into
                            lib/combat/nluModel.ts (verified bit-exact).
train.py                -- plain numpy SGD, multinomial logistic regression
                            over the hashed features. No sklearn/pytorch.
                            Writes weights.json.
hard_cases.py            -- hand-labeled adversarial phrasing (not from
                            generate_data's templates), including the 4 real
                            session bugs, for an honest generalization check.
eval_hard.py             -- runs the trained model against hard_cases.py.
```

## Retraining

```bash
npx vitest run --config tools/nlu/vitest.config.mts   # refresh vocab.json
python3 tools/nlu/generate_data.py                     # regenerate synthetic data
PYTHONPATH=tools/nlu python3 tools/nlu/train.py         # train, writes tools/nlu/weights.json
PYTHONPATH=tools/nlu python3 tools/nlu/eval_hard.py     # check it didn't regress
```

Then round and copy the weights into the app:

```bash
python3 -c "
import json
w = json.load(open('tools/nlu/weights.json'))
r = lambda x: [r(v) for v in x] if isinstance(x, list) else round(x, 6)
w['W'], w['b'] = r(w['W']), r(w['b'])
json.dump(w, open('lib/combat/nluWeights.json', 'w'))
"
npx vitest run tests/nlu-model-port.test.ts   # confirm the TS forward pass
                                               # still matches Python exactly
```

If you add a new template category to `generate_data.py` (the way to fix a
gap you notice — e.g. the "the closest kobold" / "myself" / "what are my
options" gaps found and closed in-session), rerun the whole sequence above.

## Results (this session's iteration, for reference)

| Round | Change | Hard-case exact-sentence | Token accuracy |
|---|---|---|---|
| 1 | Baseline | 11/20 | 86.0% |
| 2 | + descriptor/self-reference/info-query templates | 14/20 | 91.6% |
| 3 | Fixed a real generator bug (leaked "the" into TARGET spans) | 17/20 | 97.2% |

All 4 real session bugs correct in every round.
