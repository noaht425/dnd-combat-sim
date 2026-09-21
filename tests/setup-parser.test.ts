// Regression tests for a real bug report: naming an unbuilt subclass
// ("soul-knife rogue" at the time) failed to parse at all, and — because the
// setup parser requires every comma/"and"-separated segment in a multi-member
// message to independently succeed before accepting any of them — bundling
// it with a perfectly valid class in the same message ("... and artificer
// level 3") made the valid one silently fail too.
//
// Soulknife itself got built for real shortly after (see
// tests/rogue-subclasses.test.ts), so these now use "eldritch knight
// fighter" — Fighter still only has Champion and Battle Master built — to
// keep exercising the same still-unbuilt-subclass fallback path.

import { describe, expect, it } from "vitest";
import { advance } from "../lib/combat/orchestrator";
import { newSession } from "../lib/combat/session";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { parsePartyMember } from "../lib/combat/setupParser";

describe("setup parser — unbuilt subclass regressions", () => {
  it('an unbuilt subclass name ("eldritch knight fighter") still resolves to the one subclass that IS built, with a note', () => {
    const p = parsePartyMember("eldritch knight fighter level 3");
    expect(p.ok).toBe(true);
    expect(p.classInfo?.templateId).toBe("gwm-fighter");
    expect(p.subclassNote).toMatch(/Champion fighter is built/);
  });

  it("findClassTemplate falls back to the bare class word when the full fuzzy score misses", () => {
    expect(findClassTemplate("eldritch knight fighter").match?.templateId).toBe("gwm-fighter");
    expect(findClassTemplate("college of tragedy bard").match?.className).toBe("bard"); // (not one of the eight published colleges: it still resolves to a bard)
    expect(findClassTemplate("college of glamour bard").match?.templateId).toBe("glamour-bard"); // built now: the exact alias wins
    // now genuinely built (not a fallback) — confirms the exact-alias path
    // still wins outright over the bare-word fallback for a real subclass
    expect(findClassTemplate("shadow monk").match?.templateId).toBe("shadow-monk");
    expect(findClassTemplate("swashbuckler rogue").match?.templateId).toBe("swashbuckler-rogue");
  });

  it('a valid class bundled with an unbuilt one in one message ("eldritch knight fighter level 3 and artificer level 3") no longer sinks the valid one', () => {
    const r = advance(newSession(), "eldritch knight fighter level 3 and artificer level 3");
    const text = r.lines.join(" | ");
    expect(text).not.toMatch(/couldn't parse/);
    expect((r.session as { party?: { template: string }[] }).party?.map((m) => m.template)).toEqual(
      expect.arrayContaining(["gwm-fighter", "battlesmith-artificer"]),
    );
  });

  it("a genuinely unrecognized word still fails to parse (no false-positive fallback)", () => {
    const p = parsePartyMember("kobold level 3");
    expect(p.ok).toBe(false);
  });
});
