// Verifies Firebase Authentication ID tokens on the server WITHOUT a
// Firebase Admin service-account key (per product requirement: never create
// a service-account key / never put private server credentials on Railway
// via that route). Firebase ID tokens are standard RS256 JWTs signed by
// Google's "securetoken" system account — they can be verified using
// Google's public JWKs alone, checking issuer/audience/expiry ourselves.

const crypto = require("crypto");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "gift-visuals";
const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certCache = { certs: null, expiresAt: 0 };

async function fetchCerts() {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Firebase public certs: ${res.status}`);
  const certs = await res.json();
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 5 * 60 * 1000;
  certCache = { certs, expiresAt: Date.now() + maxAgeMs };
  return certs;
}

function base64UrlDecode(input) {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a Firebase Authentication ID token.
 * @param {string} idToken
 * @returns {Promise<{uid: string, email?: string, name?: string, picture?: string, claims: object}>}
 */
async function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw new AuthError("Missing authentication token.");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed authentication token.");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));

  if (header.alg !== "RS256") throw new AuthError("Unsupported token algorithm.");

  const certs = await fetchCerts();
  const pem = certs[header.kid];
  if (!pem) throw new AuthError("Token signed with unknown key.");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = verifier.verify(pem, signature);
  if (!valid) throw new AuthError("Invalid token signature.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new AuthError("Token expired.");
  if (payload.iat > now + 60) throw new AuthError("Token issued in the future.");
  if (payload.aud !== PROJECT_ID) throw new AuthError("Token audience mismatch.");
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) {
    throw new AuthError("Token issuer mismatch.");
  }
  if (!payload.sub) throw new AuthError("Token missing subject.");

  return {
    uid: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    claims: payload,
  };
}

class AuthError extends Error {}

/** Express middleware: requires a valid Firebase ID token in Authorization: Bearer <token>. */
function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      const user = await verifyIdToken(token);
      req.user = user;
      next();
    } catch (err) {
      res.status(401).json({ error: "Please sign in to continue.", code: "AUTH_REQUIRED" });
    }
  };
}

module.exports = { verifyIdToken, requireAuth, AuthError };
