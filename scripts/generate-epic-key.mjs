// Prints a new private RSA JWK for EPIC_PRIVATE_JWK. Store it only in Vercel env
// settings or .env.local, never in git.
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid: randomUUID(), alg: "RS384", use: "sig" };
console.log(JSON.stringify(jwk));
