// Carry AUTH_SECRET across a machine wipe without ever putting it in the clear in the factory-state repo
// (which refuses secrets). The value is sealed with FACTORY_STATE_KEY - the one passphrase the factory
// already holds outside any repo, the same one that encrypts the board database - using scrypt +
// AES-256-GCM, and written as a small JSON file next to the PGlite tarball in the snapshot folder.
//   node env-vault.mjs seal --env <.env.local> --name AUTH_SECRET --out <file.enc.json>
//   node env-vault.mjs open --in <file.enc.json>        prints the value to stdout (for the calling script only)
// Exit 0 ok · 1 error · 2 usage · 3 nothing to do (FACTORY_STATE_KEY unset, value missing, no such file)
// · 4 wrong passphrase (auth tag mismatch). Never logs the value.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (code, msg) => {
  console.error(`env-vault: ${msg}`);
  process.exit(code);
};

const passphrase = process.env.FACTORY_STATE_KEY;
if (cmd !== "seal" && cmd !== "open") fail(2, "usage: env-vault.mjs seal --env <file> --name <KEY> --out <file> | open --in <file>");
if (!passphrase) fail(3, "FACTORY_STATE_KEY is unset; nothing sealed or opened");

const deriveKey = (salt) => scryptSync(passphrase, salt, 32);

if (cmd === "seal") {
  const envPath = opt("env");
  const name = opt("name") ?? "AUTH_SECRET";
  const out = opt("out");
  if (!envPath || !out) fail(2, "seal needs --env <file> and --out <file>");
  if (!existsSync(envPath)) fail(3, `${envPath} does not exist`);
  let value = "";
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1 || t.slice(0, eq).trim() !== name) continue;
    value = t
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!value) fail(3, `${name} is not set in ${envPath}`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const record = { v: 1, name, kdf: "scrypt", cipher: "aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.error(`env-vault: sealed ${name} -> ${out}`);
} else {
  const input = opt("in");
  if (!input) fail(2, "open needs --in <file>");
  if (!existsSync(input)) fail(3, `${input} does not exist`);
  const record = JSON.parse(readFileSync(input, "utf8"));
  if (record.v !== 1 || record.cipher !== "aes-256-gcm") fail(1, `${input} is not an env-vault v1 file`);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(Buffer.from(record.salt, "base64")), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  let value;
  try {
    value = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    fail(4, `${input} was sealed with a different FACTORY_STATE_KEY`);
  }
  process.stdout.write(value);
}
