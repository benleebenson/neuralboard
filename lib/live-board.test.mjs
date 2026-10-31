import test from "node:test";
import assert from "node:assert/strict";
import { isLiveable, liveBoardDestination, parseLiveBoardRequest } from "./live-board.ts";

const owner = "owner@example.com";
const now = Date.parse("2026-10-30T12:00:00Z");
const board = { code: "ABC123", active: true, expires_at: null, owner_email: owner };

test("/live sends people into the live board, joining it", () => {
  assert.equal(liveBoardDestination(board, owner, now), "/board2?join=ABC123");
  assert.equal(liveBoardDestination({ ...board, expires_at: "2026-11-01T00:00:00Z" }, owner, now), "/board2?join=ABC123");
});

test("no board, a stopped board, an expired board or someone else's board goes nowhere", () => {
  assert.equal(liveBoardDestination(null, owner, now), null);
  assert.equal(liveBoardDestination(undefined, owner, now), null);
  assert.equal(liveBoardDestination({ ...board, active: false }, owner, now), null);
  assert.equal(liveBoardDestination({ ...board, expires_at: "2026-10-30T11:59:59Z" }, owner, now), null);
  assert.equal(liveBoardDestination({ ...board, owner_email: "someone@example.com" }, owner, now), null);
  assert.equal(liveBoardDestination({ ...board, owner_email: null }, owner, now), null);
  assert.equal(isLiveable({ ...board, expires_at: "not a date" }, owner, now), false);
});

test("a set request takes a board code (normalized) or null to clear", () => {
  assert.deepEqual(parseLiveBoardRequest({ code: " abc-123 " }), { ok: true, code: "ABC123" });
  assert.deepEqual(parseLiveBoardRequest({ code: null }), { ok: true, code: null });
  for (const body of [{}, null, { code: "" }, { code: "ABC12" }, { code: 123456 }, { code: ["ABC123"] }]) {
    assert.equal(parseLiveBoardRequest(body).ok, false);
  }
});
