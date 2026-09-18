// Regression tests for a real bug report: naming an unbuilt subclass
// ("soul-knife rogue") failed to parse at all, and — because the setup
// parser requires every comma/"and"-separated segment in a multi-member
// message to independently succeed before accepting any of them — bundling
// it with a perfectly valid class in the same message ("... and artificer
// level 3") made the valid one silently fail too.

import { describe, expect, it } from "vitest";
import { advance } from "../lib/combat/orchestrator";
import { newSession } from "../lib/combat/session";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { parsePartyMember } from "../lib/combat/setupParser";

describe("setup parser — unbuilt subclass regressions", () => {
  it('an unbuilt subclass name ("soul-knife rogue") still resolves to the one subclass that IS built, with a note', () => {
    const p = parsePartyMember("soul-knife rogue level 3");
    expect(p.ok).toBe(true);
    expect(p.classInfo?.templateId).toBe("assassin-rogue");
    expect(p.subclassNote).toMatch(/Assassin rogue is built/);
  });

  it("findClassTemplate falls back to the bare class word when the full fuzzy score misses", () => {
    expect(findClassTemplate("soul-knife rogue").match?.templateId).toBe("assassin-rogue");
    expect(findClassTemplate("shadow monk").match?.templateId).toBe("open-hand-monk");
    expect(findClassTemplate("swashbuckler rogue").match?.templateId).toBe("assassin-rogue");
  });

  it('a valid class bundled with an unbuilt one in one message ("soul-knife rogue level 3 and artificer level 3") no longer sinks the valid one', () => {
    const r = advance(newSession(), "soul-knife rogue level 3 and artificer level 3");
    const text = r.lines.join(" | ");
    expect(text).not.toMatch(/couldn't parse/);
    expect((r.session as { party?: { template: string }[] }).party?.map((m) => m.template)).toEqual(
      expect.arrayContaining(["assassin-rogue", "battlesmith-artificer"]),
    );
  });

  it("a genuinely unrecognized word still fails to parse (no false-positive fallback)", () => {
    const p = parsePartyMember("kobold level 3");
    expect(p.ok).toBe(false);
  });
});
