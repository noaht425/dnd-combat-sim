import { describe, expect, it } from "vitest";
import { runBattle } from "../src/lib/sim/battle";
import { gridFromDef, makeGrid, setTerrain } from "../src/lib/sim/battle/grid";
import { standardParty } from "../src/lib/sim/engine/scenario";

describe("battle mode — full grid fight", () => {
  it("runs a party vs a boss and returns a result + a frame stream", () => {
    const out = runBattle({
      party: standardParty(14),
      enemies: ["gladiator"],
      seed: 7,
    });
    expect(["party", "monster", "draw"]).toContain(out.result.winner);
    expect(out.result.rounds).toBeGreaterThan(0);
    expect(out.frames.length).toBeGreaterThan(5);
    // first frame carries the terrain; frames are sequential
    expect(out.frames[0].kind).toBe("start");
    expect(out.frames[0].terrain).toBeDefined();
    expect(out.frames.at(-1)!.kind).toBe("end");
    for (let i = 1; i < out.frames.length; i++) {
      expect(out.frames[i].seq).toBe(out.frames[i - 1].seq + 1);
    }
  });

  it("every unit snapshot stays inside the grid", () => {
    const out = runBattle({ party: standardParty(12), enemies: ["ogre", "ogre"], seed: 3 });
    const { width, height } = out.grid;
    for (const f of out.frames) {
      for (const u of f.units) {
        expect(u.x).toBeGreaterThanOrEqual(0);
        expect(u.y).toBeGreaterThanOrEqual(0);
        expect(u.x + u.fp).toBeLessThanOrEqual(width);
        expect(u.y + u.fp).toBeLessThanOrEqual(height);
      }
    }
  });

  it("melee combatants actually close the distance", () => {
    const out = runBattle({ party: standardParty(16), enemies: ["adult-red-dragon"], seed: 1 });
    const fighterId = out.frames[0].units.find((u) => u.side === "party" && u.glyph === "B")!.id;
    const monId = out.frames[0].units.find((u) => u.side === "monster")!.id;
    const gapAt = (f: (typeof out.frames)[number]) => {
      const me = f.units.find((u) => u.id === fighterId);
      const foe = f.units.find((u) => u.id === monId);
      return me && foe ? Math.hypot(me.x - foe.x, me.y - foe.y) : Infinity;
    };
    const moveFrames = out.frames.filter((f) => f.kind === "move" && f.actorId === fighterId);
    expect(moveFrames.length).toBeGreaterThan(0); // it moved at least once
    // by the end of round 2 the fighter is right up against the boss (contemporaneous gap),
    // not left swinging from range
    const byR2 = out.frames.filter((f) => f.round <= 2).at(-1)!;
    expect(gapAt(byR2)).toBeLessThan(gapAt(out.frames[0])); // closed ground
    expect(gapAt(byR2)).toBeLessThanOrEqual(4); // and is now in / near melee
  });

  it("the result winner is consistent with the final frame", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = runBattle({ party: standardParty(13), enemies: ["young-gold-dragon"], seed });
      expect(out.frames.at(-1)!.text).toContain(out.result.winner);
    }
  });

  it("a wall down the middle still lets the fight resolve (pathing around it)", () => {
    const grid = makeGrid(20, 16, "floor");
    for (let y = 0; y < 12; y++) setTerrain(grid, 10, y, "wall"); // wall with a gap at the bottom
    const out = runBattle({ party: standardParty(15), enemies: ["gladiator", "gladiator"], seed: 9, grid });
    expect(["party", "monster", "draw"]).toContain(out.result.winner);
    expect(out.result.rounds).toBeGreaterThanOrEqual(1);
  });

  it("honours fixed placements", () => {
    const out = runBattle({
      party: standardParty(12),
      enemies: ["ogre"],
      seed: 2,
      placements: { "pc-1-vengeance-paladin": { x: 2, y: 2 } },
    });
    const pal = out.frames[0].units.find((u) => u.id === "pc-1-vengeance-paladin");
    expect(pal).toBeDefined();
    expect({ x: pal!.x, y: pal!.y }).toEqual({ x: 2, y: 2 });
  });

  it("a melee routine out of reach after moving is wasted, not resolved at range", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: standardParty(5), enemies: ["owlbear"], seed });
      for (const f of out.frames) {
        if (f.kind !== "action" || !f.actorId || !/Multiattack|Attack \+|beak|claw/i.test(f.text ?? "")) continue;
        const actor = f.units.find((u) => u.id === f.actorId);
        const foe = f.units.find((u) => u.side !== actor?.side && (f.targetIds ?? []).includes(u.id));
        if (!actor || !foe) continue;
        // edge-to-edge squares between the two footprints
        const gx = Math.max(0, actor.x - (foe.x + foe.fp - 1), foe.x - (actor.x + actor.fp - 1));
        const gy = Math.max(0, actor.y - (foe.y + foe.fp - 1), foe.y - (actor.y + actor.fp - 1));
        const ftGap = (Math.max(gx, gy)) * 5 + Math.floor(Math.min(gx, gy) / 2) * 5;
        // a resolved weapon swing (damage numbers in the text) must be within reach
        if (/-\d+ \(/.test(f.text ?? "")) expect(ftGap, `seed ${seed} R${f.round}: ${f.text}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it("no weapon damage lands while the attacker is far from every enemy (openers included)", () => {
    const grid = gridFromDef({ width: 30, height: 30, tiles: ".".repeat(900), placements: {} });
    const ftGap = (a: { x: number; y: number; fp: number }, b: { x: number; y: number; fp: number }) => {
      const gx = Math.max(0, a.x - (b.x + b.fp - 1), b.x - (a.x + a.fp - 1));
      const gy = Math.max(0, a.y - (b.y + b.fp - 1), b.y - (a.y + a.fp - 1));
      return Math.max(gx, gy) * 5 + Math.floor(Math.min(gx, gy) / 2) * 5;
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = runBattle({ party: standardParty(11), enemies: ["troll"], seed, grid });
      for (const f of out.frames) {
        if (f.kind !== "action" || !f.actorId) continue;
        if (!/Action Surge|Multiattack|Attack \+/.test(f.text ?? "") || !/-\d+ \(/.test(f.text ?? "")) continue;
        const a = f.units.find((u) => u.id === f.actorId)!;
        const foes = f.units.filter((u) => u.side !== a.side && u.alive);
        if (!foes.length) continue;
        const nearest = Math.min(...foes.map((u) => ftGap(a, u)));
        expect(nearest, `seed ${seed} R${f.round}: ${f.text}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it("a whiffed attack routine reads as a miss, and a buff shows what it applied", () => {
    // level-16 party curbstomps a CR3 owlbear — plenty of monster whiffs + a Bless
    let sawMiss = false;
    let sawBuff = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: standardParty(16), enemies: ["owlbear"], seed });
      for (const f of out.frames) {
        if (/\((all miss|misses)\)/.test(f.text ?? "")) sawMiss = true;
        if (/Bless -> .*bless/.test(f.text ?? "")) sawBuff = true;
        // "(no effect)" should not appear for a plain weapon multiattack any more
        expect(f.text ?? "").not.toMatch(/Multiattack.*\(no effect\)/);
      }
    }
    expect(sawMiss).toBe(true);
    expect(sawBuff).toBe(true);
  });

  it("an action headline reads before its consequences (drops, reactions)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = runBattle({ party: standardParty(3), enemies: ["hill-giant"], seed });
      for (const f of out.frames) {
        const t = f.text ?? "";
        if (f.kind !== "action" && f.kind !== "legendary") continue;
        const usesAt = t.search(/ uses /);
        const subAt = t.search(/drops to 0 HP|is destroyed|rolls with it|casts Shield|casts Absorb Elements|Riposte/);
        if (usesAt >= 0 && subAt >= 0) expect(subAt, `seed ${seed}: ${t}`).toBeGreaterThan(usesAt);
      }
    }
  });

  it("a named melee attack (Bite / Claw / …) respects reach, not just actions called Attack", () => {
    const grid = gridFromDef({ width: 30, height: 12, tiles: ".".repeat(360), placements: {} });
    const ftGap = (a: { x: number; y: number; fp: number }, b: { x: number; y: number; fp: number }) => {
      const gx = Math.max(0, a.x - (b.x + b.fp - 1), b.x - (a.x + a.fp - 1));
      const gy = Math.max(0, a.y - (b.y + b.fp - 1), b.y - (a.y + a.fp - 1));
      return Math.max(gx, gy) * 5 + Math.floor(Math.min(gx, gy) / 2) * 5;
    };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: standardParty(5), enemies: ["dire-wolf x3"], seed, grid });
      for (const f of out.frames) {
        if (f.kind !== "action" || !f.actorId || !/Bite/i.test(f.text ?? "")) continue;
        if (!/-\d+ \(/.test(f.text ?? "")) continue; // only frames where the bite dealt damage
        const a = f.units.find((u) => u.id === f.actorId)!;
        if (a.side !== "monster") continue;
        const pcs = f.units.filter((u) => u.side === "party" && u.alive);
        if (!pcs.length) continue;
        const nearest = Math.min(...pcs.map((u) => ftGap(a, u)));
        expect(nearest, `seed ${seed} R${f.round}: ${f.text}`).toBeLessThanOrEqual(10);
      }
    }
  });
});
