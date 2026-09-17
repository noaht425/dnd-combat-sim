import { describe, it, expect } from "vitest";
import { tagTokens } from "../lib/combat/nluModel";

// mirrors tools/nlu/hard_cases.py exactly, for a direct cross-check
const CASES: [string[], string[]][] = [
  ["misty step back then fire bolt at owlbear 1".split(" "), ["ACTION", "ACTION", "DIR", "O", "ACTION", "ACTION", "O", "TARGET", "TARGET"]],
  ["multiattack at owlbear 2 then action surge".split(" "), ["ACTION", "O", "TARGET", "TARGET", "O", "ACTION", "ACTION"]],
  ["bless at monk 5 druid 5 rogue 5".split(" "), ["ACTION", "O", "TARGET", "TARGET", "TARGET", "TARGET", "TARGET", "TARGET"]],
  ["spike growth at kobold 1".split(" "), ["ACTION", "ACTION", "O", "TARGET", "TARGET"]],
  ["attack the closest kobold".split(" "), ["ACTION", "O", "O", "TARGET"]],
  ["i ll cast fireball on the dragon".split(" "), ["O", "O", "O", "ACTION", "O", "O", "TARGET"]],
  ["charge the goblin then flurry of blows".split(" "), ["MOVE", "O", "TARGET", "O", "ACTION", "ACTION", "ACTION"]],
  ["hold".split(" "), ["O"]],
  ["describe fireball".split(" "), ["O", "ACTION"]],
  ["cure wounds on bront".split(" "), ["ACTION", "ACTION", "O", "TARGET"]],
  ["healing word 2nd on myself".split(" "), ["ACTION", "ACTION", "ACTION", "O", "O"]],
  ["attack goblin 1 then cast shield".split(" "), ["ACTION", "TARGET", "TARGET", "O", "O", "ACTION"]],
  ["retreat".split(" "), ["MOVE"]],
  ["go attack the dragon".split(" "), ["O", "ACTION", "O", "TARGET"]],
  ["flurry of blows then attack".split(" "), ["ACTION", "ACTION", "ACTION", "O", "ACTION"]],
];

describe("TS port matches Python training predictions", () => {
  for (const [tokens, expected] of CASES) {
    it(tokens.join(" "), () => {
      expect(tagTokens(tokens)).toEqual(expected);
    });
  }
});
