import { NextResponse } from "next/server";
import { advance } from "@/lib/combat/orchestrator";
import type { FightSession } from "@/lib/combat/session";

interface Body {
  session?: FightSession;
  message: string;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  try {
    const result = advance(body.session, body.message);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "something broke resolving that turn" }, { status: 500 });
  }
}
