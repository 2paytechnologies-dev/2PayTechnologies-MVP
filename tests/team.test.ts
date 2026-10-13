import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_MS,
  buildLedger,
  cleanTip,
  formatTeamNo,
  hashDevice,
  hashToken,
  inviteIsLive,
  looksLikeInviteToken,
  memberStatus,
  newInviteToken,
  nextTeamNo,
  splitPayment,
  toConfirmation,
  type StaffLookup,
} from "@/lib/team";
import { receiptText } from "@/lib/receipts";

describe("team numbers", () => {
  it("formats W-001 / C-014", () => {
    expect(formatTeamNo("WAITER", 1)).toBe("W-001");
    expect(formatTeamNo("CASHIER", 14)).toBe("C-014");
    expect(formatTeamNo("WAITER", 1234)).toBe("W-1234");
  });

  it("numbers waiters and cashiers separately and never reuses a number, even for removed members", () => {
    expect(nextTeamNo("WAITER", [])).toBe("W-001");
    expect(nextTeamNo("WAITER", ["W-001", "W-002", "C-007", null])).toBe("W-003");
    expect(nextTeamNo("CASHIER", ["W-009", "C-001"])).toBe("C-002");
    expect(nextTeamNo("WAITER", ["W-001", "W-003"])).toBe("W-004"); // W-002 was removed: still not reused
  });
});

describe("activation links", () => {
  it("makes unguessable, URL-safe tokens and stores only their hash", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a).not.toBe(b);
    expect(looksLikeInviteToken(a)).toBe(true);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
    expect(hashToken(a)).toBe(hashToken(a));
  });

  it("rejects things that are not tokens", () => {
    for (const bad of ["", "short", "x".repeat(44), "../etc/passwd", 123, null, undefined, "a b".padEnd(43, "c")]) expect(looksLikeInviteToken(bad)).toBe(false);
  });

  it("expires after 72 hours", () => {
    expect(INVITE_TTL_MS).toBe(72 * 3600_000);
    const now = Date.parse("2026-10-13T10:00:00Z");
    expect(inviteIsLive(new Date(now + 60_000).toISOString(), now)).toBe(true);
    expect(inviteIsLive(new Date(now - 1).toISOString(), now)).toBe(false);
    expect(inviteIsLive(null, now)).toBe(false);
  });

  it("reports a member's state", () => {
    const now = Date.parse("2026-10-13T10:00:00Z");
    const later = new Date(now + 1000).toISOString();
    const earlier = new Date(now - 1000).toISOString();
    expect(memberStatus({ activated_at: earlier, invite_expires_at: null }, now)).toBe("ACTIVE");
    expect(memberStatus({ activated_at: null, invite_expires_at: later }, now)).toBe("INVITED");
    expect(memberStatus({ activated_at: null, invite_expires_at: earlier }, now)).toBe("EXPIRED");
  });

  it("fingerprints a device without storing its id", () => {
    const id = "abcdefghijklmnop1234";
    expect(hashDevice(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDevice(id)).not.toContain(id);
    expect(hashDevice(id)).not.toBe(hashDevice(id + "x"));
  });
});

describe("tips", () => {
  it("accepts none, a normal tip, and rejects nonsense", () => {
    expect(cleanTip(undefined, 750)).toBe(0);
    expect(cleanTip("", 750)).toBe(0);
    expect(cleanTip(50, 750)).toBe(50);
    expect(cleanTip("37.456", 750)).toBe(37.46);
    expect(cleanTip(-1, 750)).toBeNull();
    expect(cleanTip("abc", 750)).toBeNull();
    expect(cleanTip(NaN, 750)).toBeNull();
    expect(cleanTip(751, 750)).toBeNull(); // more than the bill again
    expect(cleanTip(60_000, 200_000)).toBeNull(); // hard ceiling
  });

  it("splits 800 paid on a 750 receipt into 750 revenue and 50 tip", () => {
    expect(splitPayment(750, 750, 800)).toEqual({ revenue: 750, tip: 50, shortfall: 0 });
  });

  it("an exact payment has no tip", () => {
    expect(splitPayment(750, 750, 750)).toEqual({ revenue: 750, tip: 0, shortfall: 0 });
  });

  it("a tip chosen on the pay page is expected, not an error", () => {
    expect(splitPayment(750, 800, 800)).toEqual({ revenue: 750, tip: 50, shortfall: 0 });
    expect(splitPayment(750, 800, null)).toEqual({ revenue: 750, tip: 50, shortfall: 0 }); // provider sent no amount: trust the quote
  });

  it("paying LESS than the bill is a shortfall, never a negative tip", () => {
    expect(splitPayment(750, 750, 700)).toEqual({ revenue: 750, tip: 0, shortfall: 50 });
  });

  it("handles cents without float drift", () => {
    expect(splitPayment(0.1 + 0.2, 0.1 + 0.2, 0.7).tip).toBe(0.4);
  });
});

const staff: StaffLookup = {
  s1: { id: "s1", name: "Abebe", team_no: "W-001", role: "WAITER" },
  s2: { id: "s2", name: "Almaz", team_no: "W-002", role: "WAITER" },
};
const sale = (over: Record<string, unknown>) => ({ id: "t", merchant_id: "m", staff_id: null, amount: 100, tip_amount: 0, currency: "ETB", rail: "Telebirr", status: "SETTLED", created_at: "2026-10-13T08:00:00Z", ...over });

describe("confirmation payload", () => {
  it("names the waiter and splits revenue and tip", () => {
    const c = toConfirmation(sale({ id: "x1", staff_id: "s1", amount: "750", tip_amount: "50", settlement_method: "WALLET", settled_at: "2026-10-13T08:01:00Z" }), staff);
    expect(c).toMatchObject({ type: "payment.confirmed", id: "x1", receipt_amount: 750, tip: 50, total_paid: 800, rail: "Telebirr", settlement_method: "WALLET", at: "2026-10-13T08:01:00Z" });
    expect(c.staff).toEqual({ id: "s1", name: "Abebe", team_no: "W-001", role: "WAITER" });
  });

  it("an owner/counter sale has no staff", () => {
    expect(toConfirmation(sale({}), staff).staff).toBeNull();
  });
});

describe("daily ledger", () => {
  const rows = [
    sale({ id: "1", staff_id: "s1", amount: 750, tip_amount: 50 }),
    sale({ id: "2", staff_id: "s1", amount: 200, tip_amount: 0, status: "SUCCESS" }),
    sale({ id: "3", staff_id: "s2", amount: 300, tip_amount: 20 }),
    sale({ id: "4", staff_id: null, amount: 100 }),
    sale({ id: "5", staff_id: "s2", amount: 999, tip_amount: 99, status: "FAILED" }), // never counted
    sale({ id: "6", staff_id: "s2", amount: 50, status: "PENDING" }), // never counted
  ];

  it("groups paid sales per person, split into revenue and tips, biggest first", () => {
    const l = buildLedger(rows, staff);
    expect(l.map((x) => x.name)).toEqual(["Abebe", "Almaz", "Counter"]);
    expect(l[0]).toMatchObject({ team_no: "W-001", sales: 2, revenue: 950, tips: 50, total: 1000 });
    expect(l[1]).toMatchObject({ team_no: "W-002", sales: 1, revenue: 300, tips: 20, total: 320 });
    expect(l[2]).toMatchObject({ staff_id: null, role: "OWNER", sales: 1, revenue: 100, tips: 0 });
  });

  it("still names a member who was later removed", () => {
    const l = buildLedger([sale({ staff_id: "s3", amount: 10 })], staff);
    expect(l[0].staff_id).toBe("s3"); // unknown to the lookup: kept, not dropped
    expect(l[0].sales).toBe(1);
  });
});

describe("receipt text with a tip", () => {
  it("shows the total and mentions the tip", () => {
    const m = receiptText("en", { amount: 750, tip: 50, currency: "ETB", merchant: "Cafe", reference: "2P-1" });
    expect(m).toContain("800.00 ETB paid to Cafe");
    expect(m).toContain("includes 50.00 tip");
  });
  it("is unchanged without a tip", () => {
    expect(receiptText("en", { amount: 25, currency: "ETB", merchant: "NOC", reference: "2P-2" })).toBe("2Pay receipt: 25.00 ETB paid to NOC. Ref 2P-2. Thank you.");
  });
  it("Amharic names the tip as ጉርሻ", () => {
    expect(receiptText("am", { amount: 750, tip: 50, currency: "ETB", merchant: "Cafe", reference: "2P-1" })).toContain("ጉርሻ");
  });
});
