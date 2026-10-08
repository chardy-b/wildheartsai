// Synthetic Docker acceptance ONLY. This module replaces Better Auth in the test bundle;
// normal Next builds never import it. The real API still locks/verifies the DB session.
export const auth = { api: { async getSession({ headers }: { headers: Headers }) {
  const person = headers.get("cookie")?.match(/(?:^|;\s*)whchat-test=(alice|bob)(?:;|$)/)?.[1];
  if (!person) return null;
  return { user: { id: `synthetic-${person}`, emailVerified: true }, session: { id: `synthetic-session-${person}` } };
} } };
