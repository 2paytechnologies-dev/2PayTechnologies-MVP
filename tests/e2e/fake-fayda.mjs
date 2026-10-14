// A pretend national ID provider (OpenID Connect, like Fayda's eSignet) for the end-to-end tests. It speaks just enough of the
// standard to prove 2Pay's side: discovery, authorize (auto-approves), token (checks the client's signed assertion with its
// PUBLIC key and the PKCE verifier, and refuses a reused code), keys, and a signed userinfo. It is NOT Fayda: the real provider's
// endpoints and registration come from the National ID Program.
import http from "node:http";
import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";

const b64u = (x) => Buffer.from(x).toString("base64url");

export function startFakeFayda({ port, clientId, clientPrivateJwk, person }) {
  const issuer = `http://localhost:${port}`;
  const clientPublic = createPublicKey({ key: clientPrivateJwk, format: "jwk" });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const idpJwk = { ...publicKey.export({ format: "jwk" }), kid: "idp-1", use: "sig", alg: "RS256" };
  const sign = (claims) => {
    const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "idp-1" }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${b64u(createSign("RSA-SHA256").update(input).sign(privateKey))}`;
  };

  const codes = new Map(); // code -> { nonce, challenge, redirect }
  const tokens = new Map(); // access token -> sub
  const seen = { authorizations: 0, tokenCalls: 0, rejected: [] };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, issuer);
    const json = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };

    if (u.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks` });
    }
    if (u.pathname === "/jwks") return json(200, { keys: [idpJwk] });

    if (u.pathname === "/authorize") {
      const q = u.searchParams;
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
      const code = randomUUID();
      codes.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      seen.authorizations++;
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (u.pathname === "/token" && req.method === "POST") {
      seen.tokenCalls++;
      let raw = "";
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const reject = (why) => { seen.rejected.push(why); return json(400, { error: "invalid_grant", error_description: why }); };
      const entry = codes.get(f.get("code"));
      if (!entry) return reject("unknown or reused code");
      codes.delete(f.get("code")); // single use
      // the client proves who it is with a signed assertion
      const [h, p, s] = String(f.get("client_assertion") ?? "").split(".");
      if (f.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !h || !p || !s) return reject("no client assertion");
      if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(clientPublic, Buffer.from(s, "base64url"))) return reject("bad client assertion signature");
      const a = JSON.parse(Buffer.from(p, "base64url").toString());
      if (a.iss !== clientId || a.sub !== clientId || a.aud !== `${issuer}/token` || a.exp * 1000 < Date.now()) return reject("bad client assertion claims");
      // PKCE
      if (createHash("sha256").update(String(f.get("code_verifier"))).digest("base64url") !== entry.challenge) return reject("PKCE verifier does not match");
      if (f.get("redirect_uri") !== entry.redirect) return reject("redirect_uri mismatch");
      const access = randomUUID();
      tokens.set(access, person.sub);
      const now = Math.floor(Date.now() / 1000);
      return json(200, { token_type: "Bearer", access_token: access, id_token: sign({ iss: issuer, aud: clientId, sub: person.sub, nonce: entry.nonce, iat: now, exp: now + 300 }) });
    }

    if (u.pathname === "/userinfo") {
      const sub = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!sub) return json(401, { error: "invalid_token" });
      const now = Math.floor(Date.now() / 1000);
      // Fayda sends a signed userinfo, with names in more than one language
      return json(200, sign({ iss: issuer, aud: clientId, sub, name: [{ language: "am", value: person.nameAm }, { language: "eng", value: person.name }], iat: now, exp: now + 300 }), "application/jwt");
    }
    json(404, { error: "not found" });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({ issuer, seen, close: () => server.close() })));
}
