// Prints the SQL that adds an album with its own password, listed only for one name.
// Usage: node scripts/album-lock.mjs "<album name>" <owner name> <password>
// Run the printed SQL with: npx wrangler d1 execute photo-sharing-db --remote --command "<SQL>"
// The password itself is never stored, only a salted PBKDF2 hash of it.
import { webcrypto as c } from "node:crypto";

const [name, owner, password] = process.argv.slice(2);
if (!name || !owner || !password) {
  console.error('Usage: node scripts/album-lock.mjs "<album name>" <owner name> <password>');
  process.exit(1);
}
const iterations = 100000; // the most a Worker can check
const salt = c.getRandomValues(new Uint8Array(16));
const key = await c.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await c.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
const b64 = (u) => Buffer.from(u).toString("base64");
const hash = `pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
const id = Buffer.from(c.getRandomValues(new Uint8Array(12))).toString("hex");
const q = (s) => `'${s.replace(/'/g, "''")}'`;
console.log(
  `INSERT INTO albums (id, name, created_at, created_by, owner, lock_hash) VALUES (${q(id)}, ${q(name)}, ${Date.now()}, ${q(owner)}, ${q(owner)}, ${q(hash)})`
);
