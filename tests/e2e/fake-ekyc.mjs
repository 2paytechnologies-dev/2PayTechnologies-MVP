// A pretend Fayda e-KYC gateway (FAN + one-time code) for the end-to-end tests. It is NOT the real service: the real one is granted
// by the National ID Program, and its request format may differ from this (the adapter in src/lib/fayda-ekyc.ts is the place to adjust).
import http from "node:http";

export function startFakeEkyc({ port, key, otp, people }) {
  const sent = new Map(); // ref -> fan
  const seen = { initiate: 0, verify: 0, badAuth: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${key}`) { seen.badAuth++; return json(401, { error: "unauthorized" }); }
    if (req.url === "/otp" && req.method === "POST") {
      seen.initiate++;
      if (!/^\d{16}$/.test(body.individualId ?? "") || body.individualIdType !== "FAN") return json(400, { error: "bad request" });
      if (!people[body.individualId]) return json(404, { error: "unknown FAN" });
      sent.set(body.transactionID, body.individualId);
      return json(200, { transactionID: body.transactionID, maskedPhone: "09••••7788" });
    }
    if (req.url === "/verify" && req.method === "POST") {
      seen.verify++;
      const fan = sent.get(body.transactionID);
      if (!fan || fan !== body.individualId || body.otp !== otp) return json(200, { authStatus: false });
      return json(200, { authStatus: true, transactionID: body.transactionID, name: [{ language: "am", value: people[fan].nameAm }, { language: "eng", value: people[fan].name }] });
    }
    json(404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ seen, close: () => server.close() })));
}
