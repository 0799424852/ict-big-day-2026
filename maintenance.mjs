// source/maintenance.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

// source/auth.mjs
import { scrypt, randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
var derive = promisify(scrypt);
var cost = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
var day = 24 * 60 * 60 * 1e3;
var digest = (value) => createHash("sha256").update(value).digest("hex");
var token = () => randomBytes(32).toString("base64url");
var normalEmail = (value) => String(value || "").trim().toLowerCase();
function checkEmail(value) {
  const email = normalEmail(value);
  if (email.length > 254 || !/^\S+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
  return email;
}
function checkPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) throw Object.assign(new Error("Use a password or passphrase of 12\u2013128 characters."), { status: 400 });
  return value;
}
async function passwordHash(password) {
  checkPassword(password);
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 32, cost);
  return salt + ":" + key.toString("hex");
}
async function passwordMatches(password, stored) {
  const [salt, key] = (stored || "00000000000000000000000000000000:" + "0".repeat(64)).split(":");
  const derived = await derive(String(password).slice(0, 129), salt, 32, cost);
  const expected = Buffer.from(key, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
function authStore(sql2) {
  function ownerId() {
    return sql2.prepare("SELECT value FROM settings WHERE key='workspace_owner'").get()?.value || null;
  }
  function limit(key, maximum, period = 15 * 60 * 1e3) {
    const stamp = Date.now();
    sql2.prepare("DELETE FROM auth_limits WHERE expires_at<?").run(stamp);
    sql2.prepare("INSERT INTO auth_limits (key,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1").run(digest(key), stamp + period);
    if (sql2.prepare("SELECT attempts FROM auth_limits WHERE key=?").get(digest(key)).attempts > maximum) throw Object.assign(new Error("Too many attempts. Please wait before trying again."), { status: 429 });
  }
  function account(id) {
    return sql2.prepare("SELECT id,email,name,email_verified FROM auth_users WHERE id=?").get(id) || null;
  }
  async function create({ email, name, password }, owner = false) {
    email = checkEmail(email);
    name = String(name || "").trim();
    if (name.length < 2 || name.length > 100) throw Object.assign(new Error("Enter a name of 2\u2013100 characters."), { status: 400 });
    if (sql2.prepare("SELECT id FROM auth_users WHERE email=?").get(email)) throw Object.assign(new Error("This address cannot be registered. Try signing in or contact the organiser."), { status: 400 });
    const hash = await passwordHash(password), id = randomUUID();
    sql2.exec("BEGIN IMMEDIATE");
    try {
      if (owner && ownerId()) throw Object.assign(new Error("The administrator has already been created."), { status: 409 });
      sql2.prepare("INSERT INTO auth_users (id,email,name,password_hash,email_verified,created_at) VALUES (?,?,?,?,?,?)").run(id, email, name, hash, owner ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString());
      if (owner) sql2.prepare("INSERT INTO settings (key,value) VALUES ('workspace_owner',?)").run(id);
      sql2.exec("COMMIT");
    } catch (error) {
      sql2.exec("ROLLBACK");
      throw error;
    }
    return account(id);
  }
  function session(userId) {
    const value = token();
    sql2.prepare("DELETE FROM auth_sessions WHERE expires_at<?").run(Date.now());
    sql2.prepare("INSERT INTO auth_sessions (hash,user_id,expires_at) VALUES (?,?,?)").run(digest(value), userId, Date.now() + day);
    return value;
  }
  function authenticate(value) {
    if (!value || value.length > 100) return null;
    return sql2.prepare("SELECT u.id,u.email,u.name,u.email_verified FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?").get(digest(value), Date.now()) || null;
  }
  async function login(email, password) {
    const user = sql2.prepare("SELECT * FROM auth_users WHERE email=?").get(normalEmail(email));
    const good = await passwordMatches(password, user?.password_hash);
    if (!user || !good) throw Object.assign(new Error("The email or password is incorrect."), { status: 401 });
    return account(user.id);
  }
  function logout(value) {
    if (value) sql2.prepare("DELETE FROM auth_sessions WHERE hash=?").run(digest(value));
  }
  function reset(userId) {
    if (!account(userId)) throw Object.assign(new Error("Account not found."), { status: 404 });
    const value = token();
    sql2.prepare("DELETE FROM auth_resets WHERE user_id=? OR expires_at<?").run(userId, Date.now());
    sql2.prepare("INSERT INTO auth_resets (hash,user_id,expires_at) VALUES (?,?,?)").run(digest(value), userId, Date.now() + 30 * 60 * 1e3);
    return value;
  }
  function resetValid(value) {
    return sql2.prepare("SELECT * FROM auth_resets WHERE hash=? AND expires_at>?").get(digest(String(value)), Date.now());
  }
  async function changePassword(value, password) {
    const row = resetValid(value);
    if (!row) throw Object.assign(new Error("This password reset link has expired or was already used."), { status: 400 });
    const hash = await passwordHash(password);
    sql2.exec("BEGIN IMMEDIATE");
    try {
      if (!resetValid(value)) throw Object.assign(new Error("This password reset link was already used."), { status: 400 });
      sql2.prepare("UPDATE auth_users SET password_hash=? WHERE id=?").run(hash, row.user_id);
      sql2.prepare("DELETE FROM auth_resets WHERE user_id=?").run(row.user_id);
      sql2.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(row.user_id);
      sql2.exec("COMMIT");
    } catch (error) {
      sql2.exec("ROLLBACK");
      throw error;
    }
  }
  return { ownerId, limit, account, create, session, authenticate, login, logout, reset, resetValid, changePassword };
}

// source/maintenance.mjs
var root = dirname(fileURLToPath(import.meta.url));
var data = join(root, "data");
if (!existsSync(join(data, "event.sqlite"))) throw new Error("Start the website and create an administrator first.");
var sql = new DatabaseSync(join(data, "event.sqlite"));
sql.exec("PRAGMA busy_timeout=5000");
if (process.argv.includes("--recover")) {
  const auth = authStore(sql), owner = auth.ownerId();
  if (!owner) throw new Error("Create an administrator first.");
  const value = auth.reset(owner);
  console.log("\nAdministrator recovery link (expires in 30 minutes; works once):\nhttp://127.0.0.1:3000/auth/reset?token=" + value + "\nKeep it private. The website must be running.");
} else {
  const destination = join(root, "backups", (/* @__PURE__ */ new Date()).toISOString().replaceAll(":", "-").replaceAll(".", "-"));
  mkdirSync(destination, { recursive: true });
  await backup(sql, join(destination, "event.sqlite"));
  for (const name of ["uploads", "hosting.json", "tunnel-token.txt", "instance-id.txt"]) if (existsSync(join(data, name))) cpSync(join(data, name), join(destination, name), { recursive: true });
  writeFileSync(join(destination, "RESTORE.txt"), "Keep this backup private. To restore, stop the website, rename the current data folder, create a new data folder and copy event.sqlite plus the other files/folders from this backup into it. Never combine old SQLite WAL/SHM files with the restored database.\n");
  console.log("\nBackup created:\n" + destination + "\nIt contains personal records and may contain the tunnel token. Store it privately.");
}
sql.close();
