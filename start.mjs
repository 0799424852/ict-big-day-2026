// source/start.mjs
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";
import { existsSync as existsSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, renameSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

// source/server.mjs
import { readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, existsSync, statSync, unlinkSync } from "node:fs";
import { join as join2 } from "node:path";

// source/store.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function openStore(directory, migrations) {
  mkdirSync(directory, { recursive: true, mode: 448 });
  const sql = new DatabaseSync(join(directory, "event.sqlite"));
  sql.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  sql.exec("CREATE TABLE IF NOT EXISTS host_migrations (name TEXT PRIMARY KEY)");
  for (const file of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
    if (sql.prepare("SELECT name FROM host_migrations WHERE name=?").get(file)) continue;
    sql.exec("BEGIN IMMEDIATE");
    try {
      sql.exec(readFileSync(join(migrations, file), "utf8"));
      sql.prepare("INSERT INTO host_migrations (name) VALUES (?)").run(file);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS auth_users (
 id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,
 email_verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_resets (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
  class Statement {
    constructor(query, args = []) {
      this.query = query;
      this.args = args;
    }
    bind(...args) {
      return new Statement(this.query, args);
    }
    async first() {
      return sql.prepare(this.query).get(...this.args) || null;
    }
    async all() {
      return { results: sql.prepare(this.query).all(...this.args), success: true };
    }
    runSync() {
      const out = sql.prepare(this.query).run(...this.args);
      return { success: true, meta: { changes: Number(out.changes) } };
    }
    async run() {
      return this.runSync();
    }
  }
  const db = { prepare: (query) => new Statement(query), batch: async (statements) => {
    sql.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => s.runSync());
      sql.exec("COMMIT");
      return out;
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  } };
  let tail = Promise.resolve();
  const exclusive = (operation) => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => {
    });
    return next;
  };
  return { sql, db, exclusive, close: () => sql.close() };
}

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
function authStore(sql) {
  function ownerId() {
    return sql.prepare("SELECT value FROM settings WHERE key='workspace_owner'").get()?.value || null;
  }
  function limit(key, maximum, period = 15 * 60 * 1e3) {
    const stamp = Date.now();
    sql.prepare("DELETE FROM auth_limits WHERE expires_at<?").run(stamp);
    sql.prepare("INSERT INTO auth_limits (key,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1").run(digest(key), stamp + period);
    if (sql.prepare("SELECT attempts FROM auth_limits WHERE key=?").get(digest(key)).attempts > maximum) throw Object.assign(new Error("Too many attempts. Please wait before trying again."), { status: 429 });
  }
  function account(id2) {
    return sql.prepare("SELECT id,email,name,email_verified FROM auth_users WHERE id=?").get(id2) || null;
  }
  async function create({ email, name, password }, owner = false) {
    email = checkEmail(email);
    name = String(name || "").trim();
    if (name.length < 2 || name.length > 100) throw Object.assign(new Error("Enter a name of 2\u2013100 characters."), { status: 400 });
    if (sql.prepare("SELECT id FROM auth_users WHERE email=?").get(email)) throw Object.assign(new Error("This address cannot be registered. Try signing in or contact the organiser."), { status: 400 });
    const hash = await passwordHash(password), id2 = randomUUID();
    sql.exec("BEGIN IMMEDIATE");
    try {
      if (owner && ownerId()) throw Object.assign(new Error("The administrator has already been created."), { status: 409 });
      sql.prepare("INSERT INTO auth_users (id,email,name,password_hash,email_verified,created_at) VALUES (?,?,?,?,?,?)").run(id2, email, name, hash, owner ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString());
      if (owner) sql.prepare("INSERT INTO settings (key,value) VALUES ('workspace_owner',?)").run(id2);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
    return account(id2);
  }
  function session(userId) {
    const value = token();
    sql.prepare("DELETE FROM auth_sessions WHERE expires_at<?").run(Date.now());
    sql.prepare("INSERT INTO auth_sessions (hash,user_id,expires_at) VALUES (?,?,?)").run(digest(value), userId, Date.now() + day);
    return value;
  }
  function authenticate(value) {
    if (!value || value.length > 100) return null;
    return sql.prepare("SELECT u.id,u.email,u.name,u.email_verified FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?").get(digest(value), Date.now()) || null;
  }
  async function login(email, password) {
    const user = sql.prepare("SELECT * FROM auth_users WHERE email=?").get(normalEmail(email));
    const good = await passwordMatches(password, user?.password_hash);
    if (!user || !good) throw Object.assign(new Error("The email or password is incorrect."), { status: 401 });
    return account(user.id);
  }
  function logout(value) {
    if (value) sql.prepare("DELETE FROM auth_sessions WHERE hash=?").run(digest(value));
  }
  function reset(userId) {
    if (!account(userId)) throw Object.assign(new Error("Account not found."), { status: 404 });
    const value = token();
    sql.prepare("DELETE FROM auth_resets WHERE user_id=? OR expires_at<?").run(userId, Date.now());
    sql.prepare("INSERT INTO auth_resets (hash,user_id,expires_at) VALUES (?,?,?)").run(digest(value), userId, Date.now() + 30 * 60 * 1e3);
    return value;
  }
  function resetValid(value) {
    return sql.prepare("SELECT * FROM auth_resets WHERE hash=? AND expires_at>?").get(digest(String(value)), Date.now());
  }
  async function changePassword(value, password) {
    const row = resetValid(value);
    if (!row) throw Object.assign(new Error("This password reset link has expired or was already used."), { status: 400 });
    const hash = await passwordHash(password);
    sql.exec("BEGIN IMMEDIATE");
    try {
      if (!resetValid(value)) throw Object.assign(new Error("This password reset link was already used."), { status: 400 });
      sql.prepare("UPDATE auth_users SET password_hash=? WHERE id=?").run(hash, row.user_id);
      sql.prepare("DELETE FROM auth_resets WHERE user_id=?").run(row.user_id);
      sql.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(row.user_id);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  }
  return { ownerId, limit, account, create, session, authenticate, login, logout, reset, resetValid, changePassword };
}

// source/app/lib/programme.ts
var programme = [
  ["arrival", "08:00", "09:00", "Arrival, registration and exhibition viewing", "Networking", "Registration and organising team", "Check in, explore student work and meet potential collaborators."],
  ["opening", "09:00", "09:05", "Opening and introduction", "Ceremony", "Dr Phumzile Mseteka and Ms Zenzele Malale", "Understand the programme and how to participate."],
  ["choir-opening", "", "", "Musical item", "Ceremony", "UMP Choir", "Opening musical performance. Timing to be confirmed."],
  ["welcome", "09:05", "09:15", "Welcoming address", "Talk", "MANCO representative", "Welcome to the first annual ICT Big Day."],
  ["purpose", "09:15", "09:25", "Purpose of ICT Big Day and expected outcomes", "Talk", "Dr Norwell Zhakata \xB7 SCMS", "Connect the day to innovation, entrepreneurship, industry collaboration and 4IR."],
  ["keynote", "09:25", "09:55", "ICT, innovation, entrepreneurship and the future of work", "Talk", "Invited keynote speaker", "Explore how ICT can translate ideas into practical opportunities."],
  ["alumni", "09:55", "10:20", "Alumni industry insights", "Talk", "Mr Tshepo Ntimane and Mr Sydwell Mazibuko \xB7 online", "Learn from the career journeys of two former students."],
  ["business", "10:20", "10:40", "Local business and entrepreneurship insights", "Talk", "Local business representatives \xB7 Mr Thando Kayise, Kayise IT", "Explore local business needs and entrepreneurship opportunities."],
  ["government", "10:40", "10:50", "Digital transformation and ICT opportunities", "Talk", "Government representative", "Identify opportunities for ICT in government and communities."],
  ["international", "10:50", "11:05", "International 4IR insights", "Talk", "Mrs Irvah Mkhatshwa \xB7 Mlumati TVET College \xB7 live from China", "Explore innovation and global collaboration."],
  ["tea", "11:05", "11:20", "Tea, exhibitions and networking", "Networking", "All participants", "Try demonstrations and start a conversation with a student team."],
  ["panel-one", "11:20", "12:15", "Industry, government, academia and entrepreneurship \xB7 Panel 1", "Panel", "Moderator: Ms Precious Leutle. Panellists: Mr Rivalani Hlangwani, Ms Joy Zungu, Mr Bongani Sibuyi and Mr Elijah Mziyako.", "Discuss barriers and opportunities for collaboration. The draft assigns 11:20\u201312:15 to this row; the complete two-panel block needs confirmation."],
  ["choir-panel", "", "", "Musical item", "Ceremony", "UMP Choir", "Musical interlude. Timing to be confirmed."],
  ["panel-two", "", "", "Industry, government, academia and entrepreneurship \xB7 Panel 2", "Panel", "Moderator: Ms Precious Leutle. Panellists: Mr Michael Ramatapa, Ms Sinazo Matyila, Rendani Ramaphosa and Dr Siyasanga Mgoduka.", "Discuss student innovation, teaching, ICT operations and enterprise development. Timing to be confirmed."],
  ["collaboration", "12:15", "12:25", "Call for collaboration and community impact", "Collaboration", "Ms Confidence Ndlovu \xB7 Enactus representative", "Record an offer, a need or a community challenge and agree on a follow-up."],
  ["pitches", "12:25", "13:15", "Student innovation project pitch competition", "Showcase", "Five selected student teams and judges: Mr C Ndlovu, Ms Issah Ngomane, Ms Duduzile Masuku and Dr Bonga Nomvete.", "Demonstrate student solutions and identify support for their next stage."],
  ["lunch", "13:15", "14:00", "Networking lunch and exhibitions", "Networking", "All participants \xB7 judges\u2019 deliberations", "Connect with project teams, mentors and partners."],
  ["abstract-awards", "14:00", "14:15", "Remarks and announcement of abstract winners", "Ceremony", "Prof Wayi Mgwebi, Dr Hope Mauwa, Dr Norwell Zhakata, Dr Phumzile Mseteka, Dr Yves Semegni, Dr Pardon Maoneke and Dr Motselisi Chere.", "Recognise the two best abstracts. Award categories and announcement order to be confirmed."],
  ["awards", "14:15", "14:25", "Appreciation, certificates and project awards", "Ceremony", "Executive team \xB7 Vuyo Ntshingane and Dimpo Nyaloko", "Recognise panellists, guest speakers and project winners. Final award categories to be confirmed."],
  ["closing", "14:25", "14:35", "Vote of thanks and official closing", "Ceremony", "Mr MA Makome \xB7 organising committee", "Reflect on the day and confirm the next steps for collaboration."],
  ["photo", "14:35", "14:50", "Official group photograph", "Ceremony", "Guests, winners, staff and participants", "Capture the first annual ICT Big Day."],
  ["departure", "14:50", "15:00", "Departure", "Ceremony", "All participants", "Travel safely and stay connected."]
];
var defaults = {
  event_title: "ICT Big Day 2026",
  date: "2026-10-23",
  venue: "New Great Hall",
  start: "08:00",
  end: "15:00",
  theme: "ICT Innovation, Entrepreneurship, Industry Collaboration and the Fourth Industrial Revolution",
  stream_url: "",
  announcement: "Welcome to the first annual ICT Big Day. Complete your profile and start exploring the programme.",
  stage: "upcoming",
  judging_open: "false",
  reviewing_open: "false",
  abstracts_open: "true",
  projects_open: "true"
};
var categories = ["AI and data", "Software and apps", "IoT and robotics", "Cybersecurity", "Digital inclusion", "Other"];
var rubric = [["relevance", "Problem relevance"], ["innovation", "Innovation"], ["feasibility", "Technical feasibility"], ["business", "Business potential"], ["impact", "Community impact"]];
var abstractRubric = [["relevance", "Relevance to ICT Big Day"], ["originality", "Originality"], ["clarity", "Clarity"], ["rigour", "Method and evidence"], ["impact", "Potential impact"]];

// source/app/lib/permissions.ts
var privilegedRoles = ["judge", "reviewer", "organiser", "administrator"];
function hasRole(profile, role) {
  return !!profile && (profile.role === role || !!profile.roles?.includes(role));
}
function canOrganise(profile) {
  return hasRole(profile, "organiser") || hasRole(profile, "administrator");
}
function canAdminister(profile) {
  return hasRole(profile, "administrator");
}

// source/app/lib/core.ts
var AppError = class extends Error {
  status;
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
};
var id = () => crypto.randomUUID();
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
var all = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;
var one = async (db, sql, ...args) => stmt(db, sql, ...args).first();
function text(d, k, min = 0, max = 500) {
  const v = d[k];
  if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw new AppError(k.replaceAll("_", " ") + " must contain " + min + "\u2013" + max + " characters.");
  return v.trim();
}
function pick(d, k, choices) {
  const v = text(d, k, 1, 80);
  if (!choices.includes(v)) throw new AppError("Choose a valid " + k.replaceAll("_", " ") + ".");
  return v;
}
function url(v) {
  if (!v) return "";
  try {
    const u = new URL(v);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new Error();
    return u.toString();
  } catch {
    throw new AppError("Use a complete http or https link.");
  }
}
function date(v) {
  if (!v) return "";
  const parsed = /* @__PURE__ */ new Date(v + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) throw new AppError("Use a valid date.");
  return v;
}
function organiser(p) {
  if (!canOrganise(p)) throw new AppError("Only organisers or administrators can perform this action.", 403);
}
function administrator(p) {
  if (!canAdminister(p)) throw new AppError("Only administrators can manage account permissions.", 403);
}
async function required(db, table, itemId) {
  if (!["projects", "opportunities", "connections", "questions", "sessions", "profiles", "abstracts", "assignments", "attachments"].includes(table)) throw new AppError("Invalid record.");
  const item = await one(db, "SELECT * FROM " + table + " WHERE id=?", itemId);
  if (!item) throw new AppError("This record could not be found.", 404);
  return item;
}
async function profileWithRoles(db, userId) {
  const p = await required(db, "profiles", userId);
  const grants = await all(db, "SELECT role FROM role_grants WHERE user_id=? UNION SELECT role FROM role_allowlist WHERE email=? AND EXISTS (SELECT 1 FROM auth_users WHERE id=? AND email_verified=1)", userId, String(p.email).trim().toLowerCase(), userId);
  return { ...p, roles: [.../* @__PURE__ */ new Set([p.role, ...grants.map((x) => x.role)])] };
}
async function checkAttachmentOwnership(db, fileId, ownerId) {
  if (!fileId) return null;
  const attachment = await required(db, "attachments", fileId);
  if (attachment.owner_id !== ownerId) throw new AppError("Use an attachment uploaded by your account.", 403);
  return fileId;
}

// source/app/lib/conference.ts
async function readPublicSubmissions(db) {
  const [projects, abstracts] = await Promise.all([
    all(db, "SELECT j.id,'' AS owner_id,j.title,j.team,j.category,j.problem,j.solution,j.stage,j.support,j.demo_url,j.business_model,j.status,j.award,j.created_at,j.attachment_id,j.public_consent,j.version,j.team AS owner_name,a.name AS attachment_name FROM projects j LEFT JOIN attachments a ON a.id=j.attachment_id WHERE j.status='approved' AND j.public_consent=1 ORDER BY j.created_at DESC"),
    all(db, "SELECT s.id,'' AS owner_id,s.title,s.authors,s.affiliations,s.category,s.keywords,s.body,s.presentation,s.project_id,s.attachment_id,s.public_consent,s.status,s.version,s.award,s.created_at,s.updated_at,a.name AS attachment_name FROM abstracts s LEFT JOIN attachments a ON a.id=s.attachment_id WHERE s.status='accepted' AND s.public_consent=1 ORDER BY s.updated_at DESC")
  ]);
  return { projects, abstracts };
}
async function readConferenceState(db, p) {
  const manager = canOrganise(p);
  const [abstracts, assignments, reviews, grants, attachments, accessGrants] = await Promise.all([
    all(db, "SELECT s.*,p.name AS owner_name,a.name AS attachment_name FROM abstracts s JOIN profiles p ON p.id=s.owner_id LEFT JOIN attachments a ON a.id=s.attachment_id WHERE ?=1 OR s.owner_id=? OR s.status='accepted' OR EXISTS(SELECT 1 FROM assignments x WHERE x.user_id=? AND x.submission_type='abstract' AND x.submission_id=s.id AND x.submission_version=s.version AND x.status!='declined') ORDER BY s.updated_at DESC", manager ? 1 : 0, p.id, p.id),
    all(db, "SELECT x.*,p.name AS assignee_name,CASE WHEN x.submission_type='project' THEN j.title ELSE s.title END AS submission_title,CASE WHEN x.submission_type='project' THEN j.version ELSE s.version END AS current_version FROM assignments x JOIN profiles p ON p.id=x.user_id LEFT JOIN projects j ON x.submission_type='project' AND j.id=x.submission_id LEFT JOIN abstracts s ON x.submission_type='abstract' AND s.id=x.submission_id WHERE ?=1 OR x.user_id=? ORDER BY x.created_at DESC", manager ? 1 : 0, p.id),
    all(db, "SELECT r.*,p.name AS reviewer_name,s.owner_id,s.status AS abstract_status FROM abstract_reviews r JOIN profiles p ON p.id=r.reviewer_id JOIN abstracts s ON s.id=r.abstract_id WHERE ?=1 OR r.reviewer_id=? OR (s.owner_id=? AND r.author_released=1 AND r.status='submitted') ORDER BY r.updated_at DESC", manager ? 1 : 0, p.id, p.id),
    manager ? all(db, "SELECT user_id,role FROM role_grants") : Promise.resolve([]),
    all(db, "SELECT id,name,size,created_at FROM attachments WHERE owner_id=? ORDER BY created_at DESC", p.id),
    manager ? all(db, "SELECT email,role FROM role_allowlist ORDER BY email") : Promise.resolve([])
  ]);
  return { abstracts, assignments, abstractReviews: reviews.map((r) => manager || r.reviewer_id === p.id ? r : { id: r.id, abstract_id: r.abstract_id, submission_version: r.submission_version, status: r.status, author_feedback: r.author_feedback, recommendation: r.recommendation, reviewer_name: "Reviewer", updated_at: r.updated_at }), roleGrants: grants, attachments, accessGrants };
}
async function submission(db, type, submissionId) {
  return required(db, type === "project" ? "projects" : "abstracts", submissionId);
}
async function currentAssignment(db, p, type, item) {
  const assignment = await one(db, "SELECT * FROM assignments WHERE user_id=? AND submission_type=? AND submission_id=? AND submission_version=? AND status!='declined'", p.id, type, item.id, item.version);
  if (!assignment) throw new AppError("This version has not been assigned to your account.", 403);
  return assignment;
}
async function checkConflict(db, profile, item) {
  const author = await required(db, "profiles", item.owner_id);
  if (item.owner_id === profile.id || String(author.email).trim().toLowerCase() === String(profile.email).trim().toLowerCase()) throw new AppError("You cannot review or judge your own submission.", 403);
}
async function open(db, key, message) {
  const setting = await one(db, "SELECT value FROM settings WHERE key=?", key);
  if (setting?.value !== "true") throw new AppError(message);
}
async function actConference(db, p, d) {
  const action = d.action;
  if (action === "abstract") {
    const intent = pick(d, "intent", ["draft", "submit"]), isSubmit = intent === "submit";
    const person = await required(db, "profiles", p.id);
    if (!person.registered_at) throw new AppError("Complete event registration before submitting an abstract.");
    if (isSubmit) await open(db, "abstracts_open", "Abstract submissions are currently closed.");
    const title = text(d, "title", 3, 200), authors = text(d, "authors", isSubmit ? 2 : 0, 500), affiliations = text(d, "affiliations", isSubmit ? 2 : 0, 500), category = pick(d, "category", categories), keywords = text(d, "keywords", isSubmit ? 2 : 0, 300), body = text(d, "body", isSubmit ? 100 : 0, 5e3), presentation = pick(d, "presentation", ["Oral presentation", "Poster", "Online presentation"]);
    if (body.split(/\s+/).filter(Boolean).length > 500) throw new AppError("Keep the abstract to 500 words or fewer.");
    const projectId = typeof d.project_id === "string" && d.project_id ? d.project_id : null;
    if (projectId) {
      const linked = await required(db, "projects", projectId);
      if (linked.owner_id !== p.id) throw new AppError("Link only a project submitted by your account.", 403);
    }
    const attachmentId = await checkAttachmentOwnership(db, typeof d.attachment_id === "string" ? d.attachment_id : null, p.id);
    const consent = d.public_consent === true ? 1 : 0, abstractId = typeof d.id === "string" ? d.id : "";
    if (abstractId) {
      const item = await required(db, "abstracts", abstractId);
      if (item.owner_id !== p.id) throw new AppError("You can edit only your own abstract.", 403);
      if (!["draft", "revision_requested"].includes(item.status)) throw new AppError("This abstract is locked for review. Ask an organiser to request a revision.");
      const version = item.status === "revision_requested" ? item.version + 1 : item.version;
      await stmt(db, "UPDATE abstracts SET title=?,authors=?,affiliations=?,category=?,keywords=?,body=?,presentation=?,project_id=?,attachment_id=?,public_consent=?,status=?,version=?,decision_note=CASE WHEN ?='submitted' THEN '' ELSE decision_note END,updated_at=? WHERE id=?", title, authors, affiliations, category, keywords, body, presentation, projectId, attachmentId, consent, isSubmit ? "submitted" : "draft", version, isSubmit ? "submitted" : "draft", now(), abstractId).run();
    } else await stmt(db, "INSERT INTO abstracts (id,owner_id,title,authors,affiliations,category,keywords,body,presentation,project_id,attachment_id,public_consent,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id(), p.id, title, authors, affiliations, category, keywords, body, presentation, projectId, attachmentId, consent, isSubmit ? "submitted" : "draft", now(), now()).run();
  } else if (action === "abstract_decision") {
    organiser(p);
    const item = await required(db, "abstracts", text(d, "id", 1, 100));
    if (["draft", "withdrawn"].includes(item.status)) throw new AppError("Only submitted abstracts can receive a decision.");
    const status = pick(d, "status", ["under_review", "revision_requested", "accepted", "rejected"]), note = text(d, "decision_note", status === "revision_requested" || status === "rejected" ? 5 : 0, 2e3);
    await stmt(db, "UPDATE abstracts SET status=?,decision_note=?,award=CASE WHEN ?='accepted' THEN award ELSE '' END,updated_at=? WHERE id=?", status, note, status, now(), item.id).run();
    if (["accepted", "revision_requested", "rejected"].includes(status)) await stmt(db, "UPDATE abstract_reviews SET author_released=1 WHERE abstract_id=? AND submission_version=? AND status='submitted'", item.id, item.version).run();
  } else if (action === "abstract_award") {
    organiser(p);
    const item = await required(db, "abstracts", text(d, "id", 1, 100));
    if (item.status !== "accepted") throw new AppError("Accept the abstract before announcing an award.");
    await stmt(db, "UPDATE abstracts SET award=?,updated_at=? WHERE id=?", text(d, "award", 0, 120), now(), item.id).run();
  } else if (action === "withdraw_submission") {
    const type = pick(d, "submission_type", ["project", "abstract"]), item = await submission(db, type, text(d, "id", 1, 100));
    if (item.owner_id !== p.id && !canOrganise(p)) throw new AppError("Only the author or organising team can withdraw this submission.", 403);
    await stmt(db, "UPDATE " + (type === "project" ? "projects" : "abstracts") + " SET status='withdrawn',award='' WHERE id=?", item.id).run();
  } else if (action === "assign") {
    organiser(p);
    const type = pick(d, "submission_type", ["project", "abstract"]), item = await submission(db, type, text(d, "submission_id", 1, 100)), person = await profileWithRoles(db, text(d, "user_id", 1, 100));
    if (!hasRole(person, type === "project" ? "judge" : "reviewer")) throw new AppError("Assign a " + (type === "project" ? "judge" : "reviewer") + " role to this account first.");
    await checkConflict(db, person, item);
    if (type === "project" && item.status !== "approved") throw new AppError("Approve the project before assigning judges.");
    if (type === "abstract" && !["submitted", "under_review"].includes(item.status)) throw new AppError("Only an active submitted abstract can be assigned.");
    await stmt(db, "INSERT INTO assignments (id,user_id,submission_type,submission_id,submission_version,status,created_at) VALUES (?,?,?,?,?,'assigned',?) ON CONFLICT(user_id,submission_type,submission_id,submission_version) DO UPDATE SET status='assigned',decline_reason=''", id(), person.id, type, item.id, item.version, now()).run();
    if (type === "abstract" && item.status === "submitted") await stmt(db, "UPDATE abstracts SET status='under_review' WHERE id=?", item.id).run();
  } else if (action === "remove_assignment") {
    organiser(p);
    const assignment = await required(db, "assignments", text(d, "id", 1, 100));
    await stmt(db, "UPDATE assignments SET status='declined',decline_reason='Removed by organising team' WHERE id=?", assignment.id).run();
  } else if (action === "decline_assignment") {
    const assignment = await required(db, "assignments", text(d, "id", 1, 100));
    if (assignment.user_id !== p.id) throw new AppError("This assignment belongs to another account.", 403);
    if (assignment.status === "completed") throw new AppError("Contact an organiser to change a completed assignment.");
    await stmt(db, "UPDATE assignments SET status='declined',decline_reason=? WHERE id=?", text(d, "decline_reason", 5, 1e3), assignment.id).run();
  } else if (action === "review_abstract") {
    if (!hasRole(p, "reviewer")) throw new AppError("Reviewer access is required.", 403);
    await open(db, "reviewing_open", "Abstract reviewing is currently closed.");
    const item = await required(db, "abstracts", text(d, "abstract_id", 1, 100));
    if (!["submitted", "under_review"].includes(item.status)) throw new AppError("This abstract is not open for review.");
    await checkConflict(db, p, item);
    const assignment = await currentAssignment(db, p, "abstract", item);
    if (d.no_conflict !== true) throw new AppError("Confirm that you have no conflict of interest before reviewing.");
    const values = abstractRubric.map(([key]) => {
      const value = d[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) throw new AppError("Score each criterion from 1 to 5.");
      return value;
    });
    const status = pick(d, "status", ["draft", "submitted"]), recommendation = pick(d, "recommendation", ["accept", "revise", "reject"]), feedback = text(d, "author_feedback", status === "submitted" ? 10 : 0, 3e3), notes = text(d, "confidential_notes", 0, 3e3);
    await db.batch([
      stmt(db, "INSERT INTO abstract_reviews (id,reviewer_id,abstract_id,submission_version,relevance,originality,clarity,rigour,impact,recommendation,author_feedback,confidential_notes,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(reviewer_id,abstract_id,submission_version) DO UPDATE SET relevance=excluded.relevance,originality=excluded.originality,clarity=excluded.clarity,rigour=excluded.rigour,impact=excluded.impact,recommendation=excluded.recommendation,author_feedback=excluded.author_feedback,confidential_notes=excluded.confidential_notes,status=excluded.status,updated_at=excluded.updated_at", id(), p.id, item.id, item.version, ...values, recommendation, feedback, notes, status, now()),
      stmt(db, "UPDATE assignments SET status=? WHERE id=?", status === "submitted" ? "completed" : "in_progress", assignment.id)
    ]);
  } else if (action === "permissions") {
    administrator(p);
    const userId = text(d, "id", 1, 100);
    await required(db, "profiles", userId);
    if (!Array.isArray(d.roles) || d.roles.some((role) => typeof role !== "string" || !privilegedRoles.includes(role))) throw new AppError("Choose valid account permissions.");
    const roles = [...new Set(d.roles)];
    const owner = await one(db, "SELECT value FROM settings WHERE key='workspace_owner'");
    if (userId === owner?.value && !roles.includes("administrator")) throw new AppError("The workspace owner must remain an administrator.");
    const target = await required(db, "profiles", userId);
    await db.batch([stmt(db, "UPDATE profiles SET role=? WHERE id=?", userId === owner?.value ? "administrator" : "attendee", userId), stmt(db, "DELETE FROM role_allowlist WHERE email=?", String(target.email).trim().toLowerCase()), stmt(db, "DELETE FROM role_grants WHERE user_id=?", userId), ...roles.map((role) => stmt(db, "INSERT INTO role_grants (id,user_id,role) VALUES (?,?,?)", id(), userId, role))]);
  } else if (action === "permissions_by_email") {
    administrator(p);
    const email = text(d, "email", 5, 250).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("Enter a valid email address.");
    if (!Array.isArray(d.roles) || d.roles.some((role) => typeof role !== "string" || !privilegedRoles.includes(role))) throw new AppError("Choose valid account permissions.");
    const roles = [...new Set(d.roles)], owner = await one(db, "SELECT p.email FROM profiles p JOIN settings s ON s.key='workspace_owner' AND s.value=p.id");
    if (String(owner?.email).trim().toLowerCase() === email && !roles.includes("administrator")) throw new AppError("The workspace owner must remain an administrator.");
    await db.batch([stmt(db, "DELETE FROM role_allowlist WHERE email=?", email), stmt(db, "UPDATE profiles SET role='attendee' WHERE LOWER(TRIM(email))=? AND id!=(SELECT value FROM settings WHERE key='workspace_owner')", email), stmt(db, "DELETE FROM role_grants WHERE user_id IN (SELECT id FROM profiles WHERE LOWER(TRIM(email))=?)", email), ...roles.map((role) => stmt(db, "INSERT INTO role_allowlist (id,email,role) VALUES (?,?,?)", id(), email, role))]);
  } else if (action === "conference_export") {
    organiser(p);
    const dataset = pick(d, "dataset", ["abstracts", "abstract_reviews", "assignments"]);
    const sql = { abstracts: "SELECT title,authors,affiliations,category,keywords,body,presentation,status,version,decision_note,award,public_consent FROM abstracts", abstract_reviews: "SELECT a.title,r.submission_version,p.name AS reviewer,r.relevance,r.originality,r.clarity,r.rigour,r.impact,r.recommendation,r.author_feedback,r.confidential_notes,r.status FROM abstract_reviews r JOIN abstracts a ON a.id=r.abstract_id JOIN profiles p ON p.id=r.reviewer_id", assignments: "SELECT p.name AS assignee,x.submission_type,x.submission_id,x.submission_version,x.status,x.decline_reason FROM assignments x JOIN profiles p ON p.id=x.user_id" };
    return { rows: await all(db, sql[dataset]) };
  } else return void 0;
  return { ok: true };
}

// source/app/lib/service.ts
async function initialiseProgramme(db) {
  const seeded = await one(db, "SELECT value FROM settings WHERE key='programme_seed_v1'");
  if (!seeded) {
    await db.batch([
      ...Object.entries(defaults).map(([k, v]) => stmt(db, "INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", k, v)),
      ...programme.map((p, i) => stmt(db, "INSERT OR IGNORE INTO sessions (id,sort_order,start,end,title,category,lead,outcome) VALUES (?,?,?,?,?,?,?,?)", p[0], i, p[1], p[2], p[3], p[4], p[5], p[6])),
      stmt(db, "INSERT OR IGNORE INTO settings (key,value) VALUES ('programme_seed_v1','true')")
    ]);
  }
  const revision = await one(db, "SELECT value FROM settings WHERE key='conference_setup_v3'");
  if (!revision) await db.batch([
    stmt(db, "UPDATE sessions SET lead=REPLACE(REPLACE(REPLACE(lead,'Mr Precious Leutle','Ms Precious Leutle'),'Mr. Precious Leutle','Ms Precious Leutle'),'Mr Leutle','Ms Leutle') WHERE lead LIKE '%Leutle%'"),
    ...["reviewing_open", "abstracts_open", "projects_open"].map((key) => stmt(db, "INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", key, defaults[key])),
    stmt(db, "INSERT OR IGNORE INTO settings (key,value) VALUES ('conference_setup_v3','true')")
  ]);
}
async function prepare(db, actor) {
  if (!actor.userId || !actor.email) throw new AppError("Please sign in to participate.", 401);
  await initialiseProgramme(db);
  const owner = await one(db, "SELECT value FROM settings WHERE key='workspace_owner'");
  if (!owner) throw new AppError("The organiser must finish setting up this event.", 503);
  await stmt(db, "INSERT OR IGNORE INTO profiles (id,email,name,role,created_at) VALUES (?,?,?,?,?)", actor.userId, actor.email, actor.displayName, owner?.value === actor.userId ? "administrator" : "attendee", now()).run();
  await stmt(db, "UPDATE profiles SET email=? WHERE id=?", actor.email, actor.userId).run();
  if (owner.value === actor.userId) await stmt(db, "UPDATE profiles SET role='administrator' WHERE id=?", actor.userId).run();
  return profileWithRoles(db, actor.userId);
}
async function readAttendance(db) {
  const result = await one(db, "WITH unique_participants AS (SELECT LOWER(TRIM(email)) AS participant,MAX(CASE WHEN attendance='in_person' THEN 1 ELSE 0 END) AS in_person,MAX(CASE WHEN checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_in FROM profiles WHERE registered_at IS NOT NULL GROUP BY LOWER(TRIM(email))) SELECT COUNT(*) AS registered,COALESCE(SUM(checked_in),0) AS checkedIn,COALESCE(SUM(in_person),0) AS inPerson,COALESCE(SUM(1-in_person),0) AS online,COALESCE(SUM(checked_in*in_person),0) AS inPersonCheckedIn,COALESCE(SUM(checked_in*(1-in_person)),0) AS onlineCheckedIn FROM unique_participants");
  return { registered: Number(result?.registered || 0), checkedIn: Number(result?.checkedIn || 0), inPerson: Number(result?.inPerson || 0), online: Number(result?.online || 0), inPersonCheckedIn: Number(result?.inPersonCheckedIn || 0), onlineCheckedIn: Number(result?.onlineCheckedIn || 0) };
}
async function readStats(db) {
  const [attendance, other] = await Promise.all([readAttendance(db), one(db, "SELECT (SELECT COUNT(*) FROM projects WHERE status='approved') AS projects,(SELECT COUNT(*) FROM connections WHERE status IN ('accepted','in_progress','completed')) AS connections,(SELECT COUNT(*) FROM connections WHERE status='completed') AS completed,(SELECT COUNT(*) FROM feedback) AS feedback")]);
  return { ...attendance, ...other };
}
async function readPublicState(db) {
  await initialiseProgramme(db);
  const [config, sessions, stats, library] = await Promise.all([all(db, "SELECT key,value FROM settings WHERE key NOT IN ('workspace_owner','programme_seed_v1')"), all(db, "SELECT * FROM sessions ORDER BY sort_order"), readStats(db), readPublicSubmissions(db)]);
  return { profile: null, settings: Object.fromEntries(config.filter((x) => x.key in defaults).map((x) => [x.key, x.value])), sessions, stats, ...library, bookmarks: [], questions: [], opportunities: [], connections: [], scores: [], people: [], feedback: null, assignments: [], abstractReviews: [], attachments: [], roleGrants: [], accessGrants: [] };
}
async function readState(db, p) {
  const admin = canOrganise(p);
  const [config, sessions, bookmarks, projects, questions, opportunities, connections, scores, people, feedback, counts] = await Promise.all([
    all(db, "SELECT key,value FROM settings WHERE key NOT IN ('workspace_owner','programme_seed_v1')"),
    all(db, "SELECT * FROM sessions ORDER BY sort_order"),
    all(db, "SELECT session_id FROM bookmarks WHERE user_id=?", p.id),
    all(db, `SELECT j.*,p.name AS owner_name,a.name AS attachment_name FROM projects j JOIN profiles p ON p.id=j.owner_id LEFT JOIN attachments a ON a.id=j.attachment_id WHERE ?=1 OR j.status='approved' OR j.owner_id=? ORDER BY j.created_at DESC`, admin ? 1 : 0, p.id),
    all(db, `SELECT q.*,p.name AS author, (SELECT COUNT(*) FROM votes WHERE question_id=q.id) AS votes,(SELECT COUNT(*) FROM votes WHERE question_id=q.id AND user_id=?) AS voted FROM questions q JOIN profiles p ON p.id=q.user_id WHERE ?=1 OR q.status IN ('published','answered') OR q.user_id=? ORDER BY votes DESC,q.created_at DESC`, p.id, admin ? 1 : 0, p.id),
    all(db, `SELECT o.*,p.name AS owner_name,p.organisation FROM opportunities o JOIN profiles p ON p.id=o.owner_id WHERE o.status='open' OR o.owner_id=? OR ?=1 ORDER BY o.created_at DESC`, p.id, admin ? 1 : 0),
    all(db, `SELECT c.*,f.name AS from_name,t.name AS to_name,f.email AS from_email,t.email AS to_email,f.share_contact AS from_share,t.share_contact AS to_share,j.title AS project_title,o.title AS opportunity_title FROM connections c JOIN profiles f ON f.id=c.from_id JOIN profiles t ON t.id=c.to_id LEFT JOIN projects j ON j.id=c.project_id LEFT JOIN opportunities o ON o.id=c.opportunity_id WHERE c.from_id=? OR c.to_id=? OR ?=1 ORDER BY c.created_at DESC`, p.id, p.id, admin ? 1 : 0),
    admin ? all(db, "SELECT s.*,p.name AS judge_name FROM scores s JOIN profiles p ON p.id=s.judge_id JOIN projects j ON j.id=s.project_id WHERE s.submission_version=j.version") : hasRole(p, "judge") ? all(db, "SELECT s.* FROM scores s JOIN projects j ON j.id=s.project_id WHERE s.judge_id=? AND s.submission_version=j.version", p.id) : Promise.resolve([]),
    admin ? all(db, "SELECT profiles.*,COALESCE(auth_users.email_verified,0) AS email_verified FROM profiles LEFT JOIN auth_users ON profiles.id=auth_users.id ORDER BY profiles.created_at DESC") : Promise.resolve([]),
    one(db, "SELECT learning,next_step,rating FROM feedback WHERE user_id=?", p.id),
    readStats(db)
  ]);
  const conference = await readConferenceState(db, p);
  return {
    ...conference,
    profile: p,
    settings: { ...defaults, ...Object.fromEntries(config.filter((x) => x.key in defaults).map((x) => [x.key, x.value])) },
    sessions,
    bookmarks: bookmarks.map((x) => x.session_id),
    projects,
    questions: questions.map((q) => ({ ...q, author: q.anonymous ? admin ? q.author + " (anonymous to participants)" : q.user_id === p.id ? "You (anonymous)" : "Anonymous participant" : q.author, user_id: admin || q.user_id === p.id ? q.user_id : void 0 })),
    opportunities,
    connections: connections.map((c) => {
      const accepted = ["accepted", "in_progress", "completed"].includes(c.status);
      return { ...c, from_email: accepted && c.from_share ? c.from_email : void 0, to_email: accepted && c.to_share ? c.to_email : void 0, from_share: void 0, to_share: void 0 };
    }),
    scores,
    people: people.map((person) => ({ ...person, roles: [.../* @__PURE__ */ new Set([person.role, ...conference.roleGrants.filter((g) => g.user_id === person.id).map((g) => g.role), ...conference.accessGrants.filter((g) => g.email === String(person.email).trim().toLowerCase() && person.email_verified === 1).map((g) => g.role)])] })),
    feedback,
    stats: counts
  };
}
async function act(db, p, d) {
  const action = text(d, "action", 1, 40);
  if (action === "register") {
    const name = text(d, "name", 2, 100), organisation = text(d, "organisation", 0, 160), attendance = pick(d, "attendance", ["in_person", "online"]);
    const interests = text(d, "interests", 0, 300), goal = text(d, "goal", 0, 1e3), share = d.share_contact === true ? 1 : 0;
    const pass = p.pass_code || crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    await stmt(db, "UPDATE profiles SET name=?,organisation=?,attendance=?,interests=?,goal=?,share_contact=?,registered_at=COALESCE(registered_at,?),pass_code=? WHERE id=?", name, organisation, attendance, interests, goal, share, now(), pass, p.id).run();
  } else if (action === "bookmark") {
    const sid = text(d, "session_id", 1, 80);
    await required(db, "sessions", sid);
    const exists = await one(db, "SELECT id FROM bookmarks WHERE user_id=? AND session_id=?", p.id, sid);
    if (exists) await stmt(db, "DELETE FROM bookmarks WHERE user_id=? AND session_id=?", p.id, sid).run();
    else await stmt(db, "INSERT OR IGNORE INTO bookmarks (id,user_id,session_id) VALUES (?,?,?)", id(), p.id, sid).run();
  } else if (action === "project") {
    const pid = typeof d.id === "string" ? d.id : "";
    if (pid) {
      const existing = await required(db, "projects", pid);
      if (existing.owner_id !== p.id) throw new AppError("You can edit only your own projects.", 403);
    }
    const person = await required(db, "profiles", p.id);
    if (!person.registered_at) throw new AppError("Complete event registration before submitting a project.");
    const window = await one(db, "SELECT value FROM settings WHERE key='projects_open'");
    if (window?.value === "false") throw new AppError("Project submissions are currently closed.");
    const attachment = await checkAttachmentOwnership(db, typeof d.attachment_id === "string" ? d.attachment_id : null, p.id), consent = d.public_consent === true ? 1 : 0;
    const title = text(d, "title", 3, 160), team = text(d, "team", 2, 160), category = pick(d, "category", categories), problem = text(d, "problem", 15, 2e3), solution = text(d, "solution", 15, 2e3), stage = pick(d, "stage", ["Idea", "Prototype", "Working demo"]), support = text(d, "support", 2, 500), demo = url(text(d, "demo_url", 0, 1500)), business = text(d, "business_model", 0, 1500);
    if (pid) {
      await stmt(db, "UPDATE projects SET title=?,team=?,category=?,problem=?,solution=?,stage=?,support=?,demo_url=?,business_model=?,attachment_id=?,public_consent=?,version=version+1,award='',status='pending' WHERE id=?", title, team, category, problem, solution, stage, support, demo, business, attachment, consent, pid).run();
    } else await stmt(db, "INSERT INTO projects (id,owner_id,title,team,category,problem,solution,stage,support,demo_url,business_model,status,created_at,attachment_id,public_consent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id(), p.id, title, team, category, problem, solution, stage, support, demo, business, "pending", now(), attachment, consent).run();
  } else if (action === "moderate_project") {
    organiser(p);
    const pid = text(d, "id", 1, 100);
    await required(db, "projects", pid);
    const status = pick(d, "status", ["pending", "approved", "declined"]);
    await stmt(db, "UPDATE projects SET status=? WHERE id=?", status, pid).run();
  } else if (action === "award") {
    organiser(p);
    const pid = text(d, "id", 1, 100), award = text(d, "award", 0, 120);
    const project = await required(db, "projects", pid);
    if (project.status !== "approved") throw new AppError("Approve the project before announcing an award.");
    await stmt(db, "UPDATE projects SET award=? WHERE id=?", award, pid).run();
  } else if (action === "question") {
    const sid = text(d, "session_id", 1, 80);
    if (sid !== "general") await required(db, "sessions", sid);
    await stmt(db, "INSERT INTO questions (id,user_id,session_id,body,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?)", id(), p.id, sid, text(d, "body", 10, 1e3), d.anonymous === true ? 1 : 0, "pending", now()).run();
  } else if (action === "vote") {
    const qid = text(d, "id", 1, 100), q = await required(db, "questions", qid);
    if (!["published", "answered"].includes(q.status)) throw new AppError("This question is not open for voting.");
    const exists = await one(db, "SELECT id FROM votes WHERE user_id=? AND question_id=?", p.id, qid);
    if (exists) await stmt(db, "DELETE FROM votes WHERE user_id=? AND question_id=?", p.id, qid).run();
    else await stmt(db, "INSERT OR IGNORE INTO votes (id,user_id,question_id) VALUES (?,?,?)", id(), p.id, qid).run();
  } else if (action === "moderate_question") {
    organiser(p);
    const qid = text(d, "id", 1, 100);
    await required(db, "questions", qid);
    const status = pick(d, "status", ["pending", "published", "answered", "hidden"]), answer = text(d, "answer", 0, 2e3);
    if (status === "answered" && !answer) throw new AppError("Add the answer before marking this question answered.");
    await stmt(db, "UPDATE questions SET status=?,answer=? WHERE id=?", status, answer, qid).run();
  } else if (action === "opportunity") {
    await stmt(db, "INSERT INTO opportunities (id,owner_id,kind,title,details,status,created_at) VALUES (?,?,?,?,?,?,?)", id(), p.id, pick(d, "kind", ["Offering mentorship", "Seeking mentorship", "Project partnership", "Community challenge", "Internship or opportunity"]), text(d, "title", 5, 160), text(d, "details", 15, 2e3), "open", now()).run();
  } else if (action === "close_opportunity") {
    const oid = text(d, "id", 1, 100), item = await required(db, "opportunities", oid);
    if (item.owner_id !== p.id && !canOrganise(p)) throw new AppError("Only the author can close this opportunity.", 403);
    await stmt(db, "UPDATE opportunities SET status=? WHERE id=?", pick(d, "status", ["open", "closed"]), oid).run();
  } else if (action === "connect") {
    const projectId = typeof d.project_id === "string" ? d.project_id : "", opportunityId = typeof d.opportunity_id === "string" ? d.opportunity_id : "";
    if (!!projectId === !!opportunityId) throw new AppError("Choose one project or opportunity.");
    const target = await required(db, projectId ? "projects" : "opportunities", projectId || opportunityId);
    if (projectId && target.status !== "approved") throw new AppError("This project is not available for collaboration.");
    if (opportunityId && target.status !== "open") throw new AppError("This opportunity has closed.");
    if (target.owner_id === p.id) throw new AppError("You cannot send a collaboration request to yourself.");
    const existing = await one(db, "SELECT id FROM connections WHERE from_id=? AND to_id=? AND (project_id=? OR opportunity_id=?) AND status!='declined'", p.id, target.owner_id, projectId || null, opportunityId || null);
    if (existing) throw new AppError("You already have an active request for this item.");
    await stmt(db, "INSERT INTO connections (id,from_id,to_id,project_id,opportunity_id,message,created_at) VALUES (?,?,?,?,?,?,?)", id(), p.id, target.owner_id, projectId || null, opportunityId || null, text(d, "message", 10, 1500), now()).run();
  } else if (action === "update_connection") {
    const cid = text(d, "id", 1, 100), c = await required(db, "connections", cid);
    if (c.from_id !== p.id && c.to_id !== p.id && !canOrganise(p)) throw new AppError("This collaboration belongs to other participants.", 403);
    const status = pick(d, "status", ["accepted", "declined", "in_progress", "completed"]);
    if (c.status === "pending" && c.to_id !== p.id) throw new AppError("The recipient must accept or decline this request.", 403);
    const allowed = { pending: ["accepted", "declined"], accepted: ["accepted", "in_progress", "completed"], in_progress: ["in_progress", "completed"], completed: ["completed"], declined: [] };
    if (!allowed[c.status]?.includes(status)) throw new AppError("That status change is not available.");
    const next = text(d, "next_action", 0, 1e3), due = date(text(d, "due_date", 0, 10));
    if (["accepted", "in_progress"].includes(status) && (!next || !due)) throw new AppError("Agree a next action and a follow-up date.");
    await stmt(db, "UPDATE connections SET status=?,next_action=?,due_date=? WHERE id=?", status, next, due, cid).run();
  } else if (action === "score") {
    if (!hasRole(p, "judge")) throw new AppError("Only assigned judges can submit scores.", 403);
    const config = await one(db, "SELECT value FROM settings WHERE key='judging_open'");
    if (config?.value !== "true") throw new AppError("Judging is currently closed.");
    const pid = text(d, "project_id", 1, 100), project = await required(db, "projects", pid);
    if (project.status !== "approved") throw new AppError("Only approved projects can be scored.");
    await checkConflict(db, p, project);
    const assignment = await currentAssignment(db, p, "project", project);
    if (d.no_conflict !== true) throw new AppError("Confirm that you have no conflict of interest before judging.");
    const values = rubric.map(([key]) => {
      const v = d[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) throw new AppError("Score every criterion from 1 to 5.");
      return v;
    });
    await stmt(db, "INSERT INTO scores (id,judge_id,project_id,relevance,innovation,feasibility,business,impact,feedback,updated_at,submission_version) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(judge_id,project_id,submission_version) DO UPDATE SET relevance=excluded.relevance,innovation=excluded.innovation,feasibility=excluded.feasibility,business=excluded.business,impact=excluded.impact,feedback=excluded.feedback,updated_at=excluded.updated_at", id(), p.id, pid, ...values, text(d, "feedback", 0, 1500), now(), project.version).run();
    await stmt(db, "UPDATE assignments SET status='completed' WHERE id=?", assignment.id).run();
  } else if (action === "role") {
    administrator(p);
    const uid = text(d, "id", 1, 100), role = pick(d, "role", ["attendee", "judge", "reviewer", "organiser", "administrator"]);
    await required(db, "profiles", uid);
    const owner = await one(db, "SELECT value FROM settings WHERE key='workspace_owner'");
    if (uid === owner?.value && role !== "administrator") throw new AppError("The workspace owner must remain an administrator.");
    await stmt(db, "UPDATE profiles SET role=? WHERE id=?", role, uid).run();
  } else if (action === "attend_online") {
    const profile = await required(db, "profiles", p.id);
    if (!profile.registered_at) throw new AppError("Complete registration before confirming your attendance.");
    if (profile.attendance !== "online") throw new AppError("In-person participants check in with the registration team.");
    const stage = await one(db, "SELECT value FROM settings WHERE key='stage'");
    if (stage?.value !== "live") throw new AppError("Online check-in opens when the event goes live.");
    await stmt(db, "UPDATE profiles SET checked_in_at=COALESCE(checked_in_at,?) WHERE id=?", now(), p.id).run();
  } else if (action === "checkin") {
    organiser(p);
    const code = text(d, "code", 1, 100).toUpperCase();
    const person = await one(db, "SELECT id FROM profiles WHERE UPPER(pass_code)=? AND registered_at IS NOT NULL", code);
    if (!person) throw new AppError("No registration matches that entry code.", 404);
    await stmt(db, "UPDATE profiles SET checked_in_at=COALESCE(checked_in_at,?) WHERE id=?", now(), person.id).run();
  } else if (action === "settings") {
    organiser(p);
    const values = d.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new AppError("Invalid event settings.");
    const v = values, updates = [];
    for (const k of Object.keys(v)) {
      if (!(k in defaults)) throw new AppError("Unknown event setting.");
      let value = text(v, k, 0, k === "announcement" ? 2e3 : 1500);
      if (k === "stream_url") value = url(value);
      if (k === "date") {
        if (!value) throw new AppError("Choose an event date.");
        value = date(value);
      }
      if (["start", "end"].includes(k) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new AppError("Use a valid event time.");
      if (k === "stage" && !["upcoming", "live", "closed"].includes(value)) throw new AppError("Invalid event stage.");
      if (["judging_open", "reviewing_open", "projects_open", "abstracts_open"].includes(k) && !["true", "false"].includes(value)) throw new AppError("Invalid judging setting.");
      if (["event_title", "venue", "theme"].includes(k) && !value) throw new AppError("Event title, venue and theme cannot be empty.");
      updates.push([k, value]);
    }
    const config = Object.fromEntries((await all(db, "SELECT key,value FROM settings")).map((x) => [x.key, x.value]));
    const merged = { ...config, ...Object.fromEntries(updates) };
    if (merged.end <= merged.start) throw new AppError("The event end time must be after its start.");
    await db.batch(updates.map(([k, value]) => stmt(db, "UPDATE settings SET value=? WHERE key=?", value, k)));
  } else if (action === "session") {
    organiser(p);
    const sid = text(d, "id", 1, 100);
    await required(db, "sessions", sid);
    const start = text(d, "start", 0, 5), end = text(d, "end", 0, 5);
    for (const t of [start, end]) if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new AppError("Use valid session times.");
    if (Boolean(start) !== Boolean(end) || start && end <= start) throw new AppError("Add both times, with the end after the start.");
    await stmt(db, "UPDATE sessions SET title=?,lead=?,start=?,end=?,outcome=? WHERE id=?", text(d, "title", 3, 200), text(d, "lead", 2, 1200), start, end, text(d, "outcome", 5, 1500), sid).run();
  } else if (action === "feedback") {
    const rating = d.rating;
    if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError("Choose a rating from 1 to 5.");
    await stmt(db, "INSERT INTO feedback (user_id,learning,next_step,rating,created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET learning=excluded.learning,next_step=excluded.next_step,rating=excluded.rating,created_at=excluded.created_at", p.id, text(d, "learning", 10, 1500), text(d, "next_step", 10, 1500), rating, now()).run();
  } else if (action === "export") {
    organiser(p);
    const dataset = pick(d, "dataset", ["registrations", "projects", "collaborations", "judging", "feedback"]);
    const queries = { registrations: "SELECT name,email,organisation,attendance,interests,goal,registered_at,checked_in_at,pass_code FROM profiles WHERE registered_at IS NOT NULL", projects: "SELECT title,team,category,problem,solution,stage,support,demo_url,business_model,status,award FROM projects", collaborations: "SELECT f.name AS from_name,t.name AS to_name,c.message,c.status,c.next_action,c.due_date FROM connections c JOIN profiles f ON f.id=c.from_id JOIN profiles t ON t.id=c.to_id", judging: "SELECT j.title,p.name AS judge,s.relevance,s.innovation,s.feasibility,s.business,s.impact,s.feedback FROM scores s JOIN profiles p ON p.id=s.judge_id JOIN projects j ON j.id=s.project_id", feedback: "SELECT p.name,f.learning,f.next_step,f.rating,f.created_at FROM feedback f JOIN profiles p ON p.id=f.user_id" };
    return { rows: await all(db, queries[dataset]) };
  } else {
    const result = await actConference(db, p, d);
    if (result !== void 0) return result;
    throw new AppError("Unknown action.");
  }
  return { ok: true };
}

// source/app/lib/file-access.ts
async function mayReadAttachment(db, fileId, profile) {
  const file = await one(db, "SELECT * FROM attachments WHERE id=?", fileId);
  if (!file) return null;
  if (profile && (file.owner_id === profile.id || canOrganise(profile))) return file;
  const published = await one(db, "SELECT id FROM projects WHERE attachment_id=? AND status='approved' AND (?=1 OR public_consent=1) UNION SELECT id FROM abstracts WHERE attachment_id=? AND status='accepted' AND (?=1 OR public_consent=1) LIMIT 1", fileId, profile ? 1 : 0, fileId, profile ? 1 : 0);
  if (published) return file;
  if (profile) {
    const assigned = await one(db, "SELECT x.id FROM assignments x LEFT JOIN projects j ON x.submission_type='project' AND j.id=x.submission_id LEFT JOIN abstracts a ON x.submission_type='abstract' AND a.id=x.submission_id WHERE x.user_id=? AND x.status!='declined' AND ((j.attachment_id=? AND j.version=x.submission_version) OR (a.attachment_id=? AND a.version=x.submission_version)) LIMIT 1", profile.id, fileId, fileId);
    if (assigned) return file;
  }
  return null;
}

// source/app/lib/pdf-upload.ts
async function readPdfUpload(request, maximum = 10 * 1024 * 1024) {
  if (!request.headers.get("content-type")?.includes("multipart/form-data")) throw new AppError("Choose a PDF document.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("Choose a PDF document.");
  let length = 0;
  const chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum + 131072) {
      await reader.cancel();
      throw new AppError("Use a PDF of 10 MB or less.", 413);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") } }).formData();
  if (form.getAll("file").length !== 1) throw new AppError("Upload one PDF document at a time.");
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0 || file.size > maximum) throw new AppError("Use a PDF of 10 MB or less.");
  if (!file.name.toLowerCase().endsWith(".pdf") || new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) !== "%PDF-") throw new AppError("Upload a valid PDF document.");
  return file;
}

// vendor/qrcodegen.ts
var qrcodegen;
((qrcodegen2) => {
  class QrCode {
    /*-- Constructor (low level) and fields --*/
    // Creates a new QR Code with the given version number,
    // error correction level, data codeword bytes, and mask number.
    // This is a low-level API that most users should not use directly.
    // A mid-level API is the encodeSegments() function.
    constructor(version, errorCorrectionLevel, dataCodewords, msk) {
      this.version = version;
      this.errorCorrectionLevel = errorCorrectionLevel;
      if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION)
        throw new RangeError("Version value out of range");
      if (msk < -1 || msk > 7)
        throw new RangeError("Mask value out of range");
      this.size = version * 4 + 17;
      let row = [];
      for (let i = 0; i < this.size; i++)
        row.push(false);
      for (let i = 0; i < this.size; i++) {
        this.modules.push(row.slice());
        this.isFunction.push(row.slice());
      }
      this.drawFunctionPatterns();
      const allCodewords = this.addEccAndInterleave(dataCodewords);
      this.drawCodewords(allCodewords);
      if (msk == -1) {
        let minPenalty = 1e9;
        for (let i = 0; i < 8; i++) {
          this.applyMask(i);
          this.drawFormatBits(i);
          const penalty = this.getPenaltyScore();
          if (penalty < minPenalty) {
            msk = i;
            minPenalty = penalty;
          }
          this.applyMask(i);
        }
      }
      assert(0 <= msk && msk <= 7);
      this.mask = msk;
      this.applyMask(msk);
      this.drawFormatBits(msk);
      this.isFunction = [];
    }
    version;
    errorCorrectionLevel;
    /*-- Static factory functions (high level) --*/
    // Returns a QR Code representing the given Unicode text string at the given error correction level.
    // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
    // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
    // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
    // ecl argument if it can be done without increasing the version.
    static encodeText(text2, ecl) {
      const segs = qrcodegen2.QrSegment.makeSegments(text2);
      return QrCode.encodeSegments(segs, ecl);
    }
    // Returns a QR Code representing the given binary data at the given error correction level.
    // This function always encodes using the binary segment mode, not any text mode. The maximum number of
    // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
    // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
    static encodeBinary(data, ecl) {
      const seg = qrcodegen2.QrSegment.makeBytes(data);
      return QrCode.encodeSegments([seg], ecl);
    }
    /*-- Static factory functions (mid level) --*/
    // Returns a QR Code representing the given segments with the given encoding parameters.
    // The smallest possible QR Code version within the given range is automatically
    // chosen for the output. Iff boostEcl is true, then the ECC level of the result
    // may be higher than the ecl argument if it can be done without increasing the
    // version. The mask number is either between 0 to 7 (inclusive) to force that
    // mask, or -1 to automatically choose an appropriate mask (which may be slow).
    // This function allows the user to create a custom sequence of segments that switches
    // between modes (such as alphanumeric and byte) to encode text in less space.
    // This is a mid-level API; the high-level API is encodeText() and encodeBinary().
    static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
      if (!(QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= QrCode.MAX_VERSION) || mask < -1 || mask > 7)
        throw new RangeError("Invalid value");
      let version;
      let dataUsedBits;
      for (version = minVersion; ; version++) {
        const dataCapacityBits2 = QrCode.getNumDataCodewords(version, ecl) * 8;
        const usedBits = QrSegment.getTotalBits(segs, version);
        if (usedBits <= dataCapacityBits2) {
          dataUsedBits = usedBits;
          break;
        }
        if (version >= maxVersion)
          throw new RangeError("Data too long");
      }
      for (const newEcl of [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) {
        if (boostEcl && dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8)
          ecl = newEcl;
      }
      let bb = [];
      for (const seg of segs) {
        appendBits(seg.mode.modeBits, 4, bb);
        appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
        for (const b of seg.getData())
          bb.push(b);
      }
      assert(bb.length == dataUsedBits);
      const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
      assert(bb.length <= dataCapacityBits);
      appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
      appendBits(0, (8 - bb.length % 8) % 8, bb);
      assert(bb.length % 8 == 0);
      for (let padByte = 236; bb.length < dataCapacityBits; padByte ^= 236 ^ 17)
        appendBits(padByte, 8, bb);
      let dataCodewords = [];
      while (dataCodewords.length * 8 < bb.length)
        dataCodewords.push(0);
      bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << 7 - (i & 7));
      return new QrCode(version, ecl, dataCodewords, mask);
    }
    /*-- Fields --*/
    // The width and height of this QR Code, measured in modules, between
    // 21 and 177 (inclusive). This is equal to version * 4 + 17.
    size;
    // The index of the mask pattern used in this QR Code, which is between 0 and 7 (inclusive).
    // Even if a QR Code is created with automatic masking requested (mask = -1),
    // the resulting object still has a mask value between 0 and 7.
    mask;
    // The modules of this QR Code (false = light, true = dark).
    // Immutable after constructor finishes. Accessed through getModule().
    modules = [];
    // Indicates function modules that are not subjected to masking. Discarded when constructor finishes.
    isFunction = [];
    /*-- Accessor methods --*/
    // Returns the color of the module (pixel) at the given coordinates, which is false
    // for light or true for dark. The top left corner has the coordinates (x=0, y=0).
    // If the given coordinates are out of bounds, then false (light) is returned.
    getModule(x, y) {
      return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
    }
    /*-- Private helper methods for constructor: Drawing function modules --*/
    // Reads this object's version field, and draws and marks all function modules.
    drawFunctionPatterns() {
      for (let i = 0; i < this.size; i++) {
        this.setFunctionModule(6, i, i % 2 == 0);
        this.setFunctionModule(i, 6, i % 2 == 0);
      }
      this.drawFinderPattern(3, 3);
      this.drawFinderPattern(this.size - 4, 3);
      this.drawFinderPattern(3, this.size - 4);
      const alignPatPos = this.getAlignmentPatternPositions();
      const numAlign = alignPatPos.length;
      for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
          if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
            this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }
      this.drawFormatBits(0);
      this.drawVersion();
    }
    // Draws two copies of the format bits (with its own error correction code)
    // based on the given mask and this object's error correction level field.
    drawFormatBits(mask) {
      const data = this.errorCorrectionLevel.formatBits << 3 | mask;
      let rem = data;
      for (let i = 0; i < 10; i++)
        rem = rem << 1 ^ (rem >>> 9) * 1335;
      const bits = (data << 10 | rem) ^ 21522;
      assert(bits >>> 15 == 0);
      for (let i = 0; i <= 5; i++)
        this.setFunctionModule(8, i, getBit(bits, i));
      this.setFunctionModule(8, 7, getBit(bits, 6));
      this.setFunctionModule(8, 8, getBit(bits, 7));
      this.setFunctionModule(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++)
        this.setFunctionModule(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++)
        this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++)
        this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
      this.setFunctionModule(8, this.size - 8, true);
    }
    // Draws two copies of the version bits (with its own error correction code),
    // based on this object's version field, iff 7 <= version <= 40.
    drawVersion() {
      if (this.version < 7)
        return;
      let rem = this.version;
      for (let i = 0; i < 12; i++)
        rem = rem << 1 ^ (rem >>> 11) * 7973;
      const bits = this.version << 12 | rem;
      assert(bits >>> 18 == 0);
      for (let i = 0; i < 18; i++) {
        const color = getBit(bits, i);
        const a = this.size - 11 + i % 3;
        const b = Math.floor(i / 3);
        this.setFunctionModule(a, b, color);
        this.setFunctionModule(b, a, color);
      }
    }
    // Draws a 9*9 finder pattern including the border separator,
    // with the center module at (x, y). Modules can be out of bounds.
    drawFinderPattern(x, y) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
            this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
        }
      }
    }
    // Draws a 5*5 alignment pattern, with the center module
    // at (x, y). All modules must be in bounds.
    drawAlignmentPattern(x, y) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++)
          this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
      }
    }
    // Sets the color of a module and marks it as a function module.
    // Only used by the constructor. Coordinates must be in bounds.
    setFunctionModule(x, y, isDark) {
      this.modules[y][x] = isDark;
      this.isFunction[y][x] = true;
    }
    /*-- Private helper methods for constructor: Codewords and masking --*/
    // Returns a new byte string representing the given data with the appropriate error correction
    // codewords appended to it, based on this object's version and error correction level.
    addEccAndInterleave(data) {
      const ver = this.version;
      const ecl = this.errorCorrectionLevel;
      if (data.length != QrCode.getNumDataCodewords(ver, ecl))
        throw new RangeError("Invalid argument");
      const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
      const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
      const rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
      const numShortBlocks = numBlocks - rawCodewords % numBlocks;
      const shortBlockLen = Math.floor(rawCodewords / numBlocks);
      let blocks = [];
      const rsDiv = QrCode.reedSolomonComputeDivisor(blockEccLen);
      for (let i = 0, k = 0; i < numBlocks; i++) {
        let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
        if (i < numShortBlocks)
          dat.push(0);
        blocks.push(dat.concat(ecc));
      }
      let result = [];
      for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
          if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
            result.push(block[i]);
        });
      }
      assert(result.length == rawCodewords);
      return result;
    }
    // Draws the given sequence of 8-bit codewords (data and error correction) onto the entire
    // data area of this QR Code. Function modules need to be marked off before this is called.
    drawCodewords(data) {
      if (data.length != Math.floor(QrCode.getNumRawDataModules(this.version) / 8))
        throw new RangeError("Invalid argument");
      let i = 0;
      for (let right = this.size - 1; right >= 1; right -= 2) {
        if (right == 6)
          right = 5;
        for (let vert = 0; vert < this.size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const upward = (right + 1 & 2) == 0;
            const y = upward ? this.size - 1 - vert : vert;
            if (!this.isFunction[y][x] && i < data.length * 8) {
              this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
              i++;
            }
          }
        }
      }
      assert(i == data.length * 8);
    }
    // XORs the codeword modules in this QR Code with the given mask pattern.
    // The function modules must be marked and the codeword bits must be drawn
    // before masking. Due to the arithmetic of XOR, calling applyMask() with
    // the same mask value a second time will undo the mask. A final well-formed
    // QR Code needs exactly one (not zero, two, etc.) mask applied.
    applyMask(mask) {
      if (mask < 0 || mask > 7)
        throw new RangeError("Mask value out of range");
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          let invert;
          switch (mask) {
            case 0:
              invert = (x + y) % 2 == 0;
              break;
            case 1:
              invert = y % 2 == 0;
              break;
            case 2:
              invert = x % 3 == 0;
              break;
            case 3:
              invert = (x + y) % 3 == 0;
              break;
            case 4:
              invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
              break;
            case 5:
              invert = x * y % 2 + x * y % 3 == 0;
              break;
            case 6:
              invert = (x * y % 2 + x * y % 3) % 2 == 0;
              break;
            case 7:
              invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
              break;
            default:
              throw new Error("Unreachable");
          }
          if (!this.isFunction[y][x] && invert)
            this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
    // Calculates and returns the penalty score based on state of this QR Code's current modules.
    // This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
    getPenaltyScore() {
      let result = 0;
      for (let y = 0; y < this.size; y++) {
        let runColor = false;
        let runX = 0;
        let runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let x = 0; x < this.size; x++) {
          if (this.modules[y][x] == runColor) {
            runX++;
            if (runX == 5)
              result += QrCode.PENALTY_N1;
            else if (runX > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runX, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runX = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
      }
      for (let x = 0; x < this.size; x++) {
        let runColor = false;
        let runY = 0;
        let runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < this.size; y++) {
          if (this.modules[y][x] == runColor) {
            runY++;
            if (runY == 5)
              result += QrCode.PENALTY_N1;
            else if (runY > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runY, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runY = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
      }
      for (let y = 0; y < this.size - 1; y++) {
        for (let x = 0; x < this.size - 1; x++) {
          const color = this.modules[y][x];
          if (color == this.modules[y][x + 1] && color == this.modules[y + 1][x] && color == this.modules[y + 1][x + 1])
            result += QrCode.PENALTY_N2;
        }
      }
      let dark = 0;
      for (const row of this.modules)
        dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
      const total = this.size * this.size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      assert(0 <= k && k <= 9);
      result += k * QrCode.PENALTY_N4;
      assert(0 <= result && result <= 2568888);
      return result;
    }
    /*-- Private helper functions --*/
    // Returns an ascending list of positions of alignment patterns for this version number.
    // Each position is in the range [0,177), and are used on both the x and y axes.
    // This could be implemented as lookup table of 40 variable-length lists of integers.
    getAlignmentPatternPositions() {
      if (this.version == 1)
        return [];
      else {
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
        let result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step)
          result.splice(1, 0, pos);
        return result;
      }
    }
    // Returns the number of data bits that can be stored in a QR Code of the given version number, after
    // all function modules are excluded. This includes remainder bits, so it might not be a multiple of 8.
    // The result is in the range [208, 29648]. This could be implemented as a 40-entry lookup table.
    static getNumRawDataModules(ver) {
      if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION)
        throw new RangeError("Version number out of range");
      let result = (16 * ver + 128) * ver + 64;
      if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7)
          result -= 36;
      }
      assert(208 <= result && result <= 29648);
      return result;
    }
    // Returns the number of 8-bit data (i.e. not error correction) codewords contained in any
    // QR Code of the given version number and error correction level, with remainder bits discarded.
    // This stateless pure function could be implemented as a (40*4)-cell lookup table.
    static getNumDataCodewords(ver, ecl) {
      return Math.floor(QrCode.getNumRawDataModules(ver) / 8) - QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    }
    // Returns a Reed-Solomon ECC generator polynomial for the given degree. This could be
    // implemented as a lookup table over all possible parameter values, instead of as an algorithm.
    static reedSolomonComputeDivisor(degree) {
      if (degree < 1 || degree > 255)
        throw new RangeError("Degree out of range");
      let result = [];
      for (let i = 0; i < degree - 1; i++)
        result.push(0);
      result.push(1);
      let root2 = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
          result[j] = QrCode.reedSolomonMultiply(result[j], root2);
          if (j + 1 < result.length)
            result[j] ^= result[j + 1];
        }
        root2 = QrCode.reedSolomonMultiply(root2, 2);
      }
      return result;
    }
    // Returns the Reed-Solomon error correction codeword for the given data and divisor polynomials.
    static reedSolomonComputeRemainder(data, divisor) {
      let result = divisor.map((_) => 0);
      for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => result[i] ^= QrCode.reedSolomonMultiply(coef, factor));
      }
      return result;
    }
    // Returns the product of the two given field elements modulo GF(2^8/0x11D). The arguments and result
    // are unsigned 8-bit integers. This could be implemented as a lookup table of 256*256 entries of uint8.
    static reedSolomonMultiply(x, y) {
      if (x >>> 8 != 0 || y >>> 8 != 0)
        throw new RangeError("Byte out of range");
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = z << 1 ^ (z >>> 7) * 285;
        z ^= (y >>> i & 1) * x;
      }
      assert(z >>> 8 == 0);
      return z;
    }
    // Can only be called immediately after a light run is added, and
    // returns either 0, 1, or 2. A helper function for getPenaltyScore().
    finderPenaltyCountPatterns(runHistory) {
      const n = runHistory[1];
      assert(n <= this.size * 3);
      const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
      return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
    }
    // Must be called at the end of a line (row or column) of modules. A helper function for getPenaltyScore().
    finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
      if (currentRunColor) {
        this.finderPenaltyAddHistory(currentRunLength, runHistory);
        currentRunLength = 0;
      }
      currentRunLength += this.size;
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      return this.finderPenaltyCountPatterns(runHistory);
    }
    // Pushes the given value to the front and drops the last value. A helper function for getPenaltyScore().
    finderPenaltyAddHistory(currentRunLength, runHistory) {
      if (runHistory[0] == 0)
        currentRunLength += this.size;
      runHistory.pop();
      runHistory.unshift(currentRunLength);
    }
    /*-- Constants and tables --*/
    // The minimum version number supported in the QR Code Model 2 standard.
    static MIN_VERSION = 1;
    // The maximum version number supported in the QR Code Model 2 standard.
    static MAX_VERSION = 40;
    // For use in getPenaltyScore(), when evaluating which mask is best.
    static PENALTY_N1 = 3;
    static PENALTY_N2 = 3;
    static PENALTY_N3 = 40;
    static PENALTY_N4 = 10;
    static ECC_CODEWORDS_PER_BLOCK = [
      // Version: (note that index 0 is for padding, and is set to an illegal value)
      //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
      [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      // Low
      [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
      // Medium
      [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      // Quartile
      [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
      // High
    ];
    static NUM_ERROR_CORRECTION_BLOCKS = [
      // Version: (note that index 0 is for padding, and is set to an illegal value)
      //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
      [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
      // Low
      [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
      // Medium
      [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
      // Quartile
      [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
      // High
    ];
  }
  qrcodegen2.QrCode = QrCode;
  function appendBits(val, len, bb) {
    if (len < 0 || len > 31 || val >>> len != 0)
      throw new RangeError("Value out of range");
    for (let i = len - 1; i >= 0; i--)
      bb.push(val >>> i & 1);
  }
  function getBit(x, i) {
    return (x >>> i & 1) != 0;
  }
  function assert(cond) {
    if (!cond)
      throw new Error("Assertion error");
  }
  class QrSegment {
    /*-- Constructor (low level) and fields --*/
    // Creates a new QR Code segment with the given attributes and data.
    // The character count (numChars) must agree with the mode and the bit buffer length,
    // but the constraint isn't checked. The given bit buffer is cloned and stored.
    constructor(mode2, numChars, bitData) {
      this.mode = mode2;
      this.numChars = numChars;
      this.bitData = bitData;
      if (numChars < 0)
        throw new RangeError("Invalid argument");
      this.bitData = bitData.slice();
    }
    mode;
    numChars;
    bitData;
    /*-- Static factory functions (mid level) --*/
    // Returns a segment representing the given binary data encoded in
    // byte mode. All input byte arrays are acceptable. Any text string
    // can be converted to UTF-8 bytes and encoded as a byte mode segment.
    static makeBytes(data) {
      let bb = [];
      for (const b of data)
        appendBits(b, 8, bb);
      return new QrSegment(QrSegment.Mode.BYTE, data.length, bb);
    }
    // Returns a segment representing the given string of decimal digits encoded in numeric mode.
    static makeNumeric(digits) {
      if (!QrSegment.isNumeric(digits))
        throw new RangeError("String contains non-numeric characters");
      let bb = [];
      for (let i = 0; i < digits.length; ) {
        const n = Math.min(digits.length - i, 3);
        appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
        i += n;
      }
      return new QrSegment(QrSegment.Mode.NUMERIC, digits.length, bb);
    }
    // Returns a segment representing the given text string encoded in alphanumeric mode.
    // The characters allowed are: 0 to 9, A to Z (uppercase only), space,
    // dollar, percent, asterisk, plus, hyphen, period, slash, colon.
    static makeAlphanumeric(text2) {
      if (!QrSegment.isAlphanumeric(text2))
        throw new RangeError("String contains unencodable characters in alphanumeric mode");
      let bb = [];
      let i;
      for (i = 0; i + 2 <= text2.length; i += 2) {
        let temp = QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i)) * 45;
        temp += QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i + 1));
        appendBits(temp, 11, bb);
      }
      if (i < text2.length)
        appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i)), 6, bb);
      return new QrSegment(QrSegment.Mode.ALPHANUMERIC, text2.length, bb);
    }
    // Returns a new mutable list of zero or more segments to represent the given Unicode text string.
    // The result may use various segment modes and switch modes to optimize the length of the bit stream.
    static makeSegments(text2) {
      if (text2 == "")
        return [];
      else if (QrSegment.isNumeric(text2))
        return [QrSegment.makeNumeric(text2)];
      else if (QrSegment.isAlphanumeric(text2))
        return [QrSegment.makeAlphanumeric(text2)];
      else
        return [QrSegment.makeBytes(QrSegment.toUtf8ByteArray(text2))];
    }
    // Returns a segment representing an Extended Channel Interpretation
    // (ECI) designator with the given assignment value.
    static makeEci(assignVal) {
      let bb = [];
      if (assignVal < 0)
        throw new RangeError("ECI assignment value out of range");
      else if (assignVal < 1 << 7)
        appendBits(assignVal, 8, bb);
      else if (assignVal < 1 << 14) {
        appendBits(2, 2, bb);
        appendBits(assignVal, 14, bb);
      } else if (assignVal < 1e6) {
        appendBits(6, 3, bb);
        appendBits(assignVal, 21, bb);
      } else
        throw new RangeError("ECI assignment value out of range");
      return new QrSegment(QrSegment.Mode.ECI, 0, bb);
    }
    // Tests whether the given string can be encoded as a segment in numeric mode.
    // A string is encodable iff each character is in the range 0 to 9.
    static isNumeric(text2) {
      return QrSegment.NUMERIC_REGEX.test(text2);
    }
    // Tests whether the given string can be encoded as a segment in alphanumeric mode.
    // A string is encodable iff each character is in the following set: 0 to 9, A to Z
    // (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
    static isAlphanumeric(text2) {
      return QrSegment.ALPHANUMERIC_REGEX.test(text2);
    }
    /*-- Methods --*/
    // Returns a new copy of the data bits of this segment.
    getData() {
      return this.bitData.slice();
    }
    // (Package-private) Calculates and returns the number of bits needed to encode the given segments at
    // the given version. The result is infinity if a segment has too many characters to fit its length field.
    static getTotalBits(segs, version) {
      let result = 0;
      for (const seg of segs) {
        const ccbits = seg.mode.numCharCountBits(version);
        if (seg.numChars >= 1 << ccbits)
          return Infinity;
        result += 4 + ccbits + seg.bitData.length;
      }
      return result;
    }
    // Returns a new array of bytes representing the given string encoded in UTF-8.
    static toUtf8ByteArray(str) {
      str = encodeURI(str);
      let result = [];
      for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) != "%")
          result.push(str.charCodeAt(i));
        else {
          result.push(parseInt(str.substring(i + 1, i + 3), 16));
          i += 2;
        }
      }
      return result;
    }
    /*-- Constants --*/
    // Describes precisely all strings that are encodable in numeric mode.
    static NUMERIC_REGEX = /^[0-9]*$/;
    // Describes precisely all strings that are encodable in alphanumeric mode.
    static ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
    // The set of all legal characters in alphanumeric mode,
    // where each character value maps to the index in the string.
    static ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  }
  qrcodegen2.QrSegment = QrSegment;
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
  let QrCode;
  ((QrCode2) => {
    class Ecc {
      // The QR Code can tolerate about 30% erroneous codewords
      /*-- Constructor and fields --*/
      constructor(ordinal, formatBits) {
        this.ordinal = ordinal;
        this.formatBits = formatBits;
      }
      ordinal;
      formatBits;
      /*-- Constants --*/
      static LOW = new Ecc(0, 1);
      // The QR Code can tolerate about  7% erroneous codewords
      static MEDIUM = new Ecc(1, 0);
      // The QR Code can tolerate about 15% erroneous codewords
      static QUARTILE = new Ecc(2, 3);
      // The QR Code can tolerate about 25% erroneous codewords
      static HIGH = new Ecc(3, 2);
    }
    QrCode2.Ecc = Ecc;
  })(QrCode = qrcodegen2.QrCode || (qrcodegen2.QrCode = {}));
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
  let QrSegment;
  ((QrSegment2) => {
    class Mode {
      /*-- Constructor and fields --*/
      constructor(modeBits, numBitsCharCount) {
        this.modeBits = modeBits;
        this.numBitsCharCount = numBitsCharCount;
      }
      modeBits;
      numBitsCharCount;
      /*-- Constants --*/
      static NUMERIC = new Mode(1, [10, 12, 14]);
      static ALPHANUMERIC = new Mode(2, [9, 11, 13]);
      static BYTE = new Mode(4, [8, 16, 16]);
      static KANJI = new Mode(8, [8, 10, 12]);
      static ECI = new Mode(7, [0, 0, 0]);
      /*-- Method --*/
      // (Package-private) Returns the bit width of the character count field for a segment in
      // this mode in a QR Code at the given version number. The result is in the range [0, 16].
      numCharCountBits(ver) {
        return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
      }
    }
    QrSegment2.Mode = Mode;
  })(QrSegment = qrcodegen2.QrSegment || (qrcodegen2.QrSegment = {}));
})(qrcodegen || (qrcodegen = {}));

// source/qr.ts
function qrSvg(text2) {
  const qr = qrcodegen.QrCode.encodeText(text2, qrcodegen.QrCode.Ecc.MEDIUM), border = 4, size = qr.size + border * 2;
  let path = "";
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

// source/server.mjs
var escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
var safeReturn = (value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f]/.test(value) && !value.startsWith("/auth/") ? value : "/#participation";
var portals = { attendee: "participation", participant: "submissions", judge: "judging", reviewer: "reviewing", organiser: "organiser", administrator: "administrator" };
var json = (body, status = 200) => Response.json(body, { status });
var redirect = (url2, headers = {}) => new Response(null, { status: 303, headers: { Location: url2, ...headers } });
function page(title, content) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} \xB7 ICT Big Day</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/host.css"></head><body><main class="host"><a class="brand" href="/">ICT BIG DAY<span>.</span></a>${content}</main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
var field = (name, label, type = "text", value = "", extra = "") => `<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
var submit = (label) => `<button type="submit">${label}</button>`;
async function createEventApp({ root: root2, dataDir = join2(root2, "data"), shareDir = join2(root2, "share"), localOrigin = "http://127.0.0.1:3000" }) {
  const store = openStore(dataDir, join2(root2, "migrations")), auth = authStore(store.sql);
  const files = join2(dataDir, "uploads");
  mkdirSync2(files, { recursive: true, mode: 448 });
  const configPath = join2(dataDir, "hosting.json");
  let config = existsSync(configPath) ? JSON.parse(readFileSync2(configPath, "utf8")) : {};
  let publicOrigin = config.publicUrl || null, publicVerified = false, setupToken = token(), activeHashes = 0;
  const instancePath = join2(dataDir, "instance-id.txt");
  if (!existsSync(instancePath)) writeFileSync(instancePath, token(), { mode: 384 });
  const instanceId = readFileSync2(instancePath, "utf8").trim();
  await store.exclusive(() => initialiseProgramme(store.db));
  const actor = (user) => ({ userId: user.id, email: user.email, displayName: user.name });
  function cookieName(secure) {
    return secure ? "__Host-ict_session" : "ict_session_local";
  }
  function cookieValue(request, secure) {
    const prefix = cookieName(secure) + "=";
    return (request.headers.get("cookie") || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(prefix))?.slice(prefix.length);
  }
  function sessionCookie(value, secure, clear = false) {
    return cookieName(secure) + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (clear ? 0 : 86400) + (secure ? "; Secure" : "");
  }
  async function fields(request) {
    const kind = request.headers.get("content-type") || "";
    let value = "";
    const reader = request.body?.getReader();
    if (!reader) throw new AppError("Empty request.");
    const chunks = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 24e3) {
        await reader.cancel();
        throw new AppError("This request is too large.", 413);
      }
      chunks.push(part.value);
    }
    value = Buffer.concat(chunks).toString("utf8");
    if (kind.includes("application/json")) {
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return parsed;
      } catch {
        throw new AppError("Invalid request.");
      }
    }
    if (kind.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(value));
    throw new AppError("Unsupported request type.", 415);
  }
  async function hashing(operation) {
    if (activeHashes >= 4) throw new AppError("Sign-in is busy. Please try again in a moment.", 429);
    activeHashes++;
    try {
      return await operation();
    } finally {
      activeHashes--;
    }
  }
  function formPage(mode2, returnTo = "", extra = "") {
    const signup = mode2 === "signup", setup = mode2 === "setup", reset = mode2 === "reset";
    const title = setup ? "Set up your event administrator" : signup ? "Create your event account" : reset ? "Choose a new password" : "Sign in to your event account";
    const action = setup ? "/host/setup" : reset ? "/auth/reset" : "/auth/" + mode2;
    const content = `<p class="eyebrow">MAKE YOUR PARTICIPATION COUNT</p><h1>${title}</h1>${extra}<form method="post" action="${action}"><input type="hidden" name="return_to" value="${escape(returnTo)}">${setup ? field("setup_token", "", "hidden", setupToken) : ""}${reset ? field("token", "", "hidden", returnTo) : ""}${signup || setup ? field("name", "Full name", "text", "", 'required minlength="2" maxlength="100" autocomplete="name"') : ""}${reset ? "" : field("email", "Email address", "email", "", 'required maxlength="254" autocomplete="email"')}${field("password", reset || signup || setup ? "Password \xB7 at least 12 characters" : "Password", "password", "", "required " + (signup || setup || reset ? 'minlength="12" maxlength="128" autocomplete="new-password"' : 'maxlength="128" autocomplete="current-password"'))}${submit(setup ? "Create administrator" : signup ? "Create account" : reset ? "Save password" : "Sign in")}</form>${setup || reset ? "" : `<p>${signup ? "Already have an account?" : "New to ICT Big Day?"} <a href="/auth/${signup ? "signin" : "signup"}?return_to=${encodeURIComponent(returnTo)}">${signup ? "Sign in" : "Create an account"}</a></p><p class="muted">Forgotten your password? Ask the organiser for a password reset link. No email is sent automatically.</p>`}<p class="muted">${signup ? "After creating your account, complete event registration to appear in the live attendance counter." : ""}</p>`;
    return page(title, content);
  }
  function validatePublicUrl(value) {
    const url2 = new URL(String(value));
    if (url2.protocol !== "https:" || url2.username || url2.password || url2.pathname !== "/" || url2.search || url2.hash || url2.port) throw new AppError("Use your public HTTPS address without a path or port.");
    return url2.origin;
  }
  function setPublicUrl(value, verified = false) {
    publicOrigin = validatePublicUrl(value);
    publicVerified = verified;
    return publicOrigin;
  }
  function hostStatus() {
    return { initialised: !!auth.ownerId(), publicUrl: publicOrigin, verified: publicVerified, instanceId };
  }
  function shareFiles(url2) {
    const directory = shareDir;
    mkdirSync2(directory, { recursive: true });
    const svg = qrSvg(url2);
    writeFileSync(join2(directory, "ICT-Big-Day-QR.svg"), svg);
    writeFileSync(join2(directory, "PUBLIC-LINK.txt"), url2 + "\n");
    writeFileSync(join2(directory, "SHARE.html"), `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ICT Big Day \xB7 Make your participation count</title><style>body{font:20px system-ui;text-align:center;max-width:760px;margin:60px auto;padding:24px;color:#172735}h1{font-size:42px}img{max-width:90%;width:440px}a{overflow-wrap:anywhere}small{display:block;margin-top:24px}</style><h1>ICT BIG DAY 2026</h1><p>University of Mpumalanga \xB7 23 October 2026</p><h2>Make your participation count.</h2><p>Scan to register, explore the programme and take part.</p><img src="ICT-Big-Day-QR.svg" alt="QR code to the ICT Big Day website"><p><a href="${escape(url2)}">${escape(url2)}</a></p><small>Hosted on the organiser\u2019s PC. Availability depends on the PC and its internet connection.</small></html>`);
  }
  async function route(request) {
    const url2 = new URL(request.url), secure = url2.protocol === "https:", isLocal = url2.origin === localOrigin && !request.headers.has("cf-ray") && !request.headers.has("x-forwarded-for");
    if (url2.origin !== localOrigin && url2.origin !== publicOrigin) throw new AppError("Unknown website address.", 421);
    if (!["GET", "HEAD", "POST"].includes(request.method)) throw new AppError("Method not allowed.", 405);
    if (request.method === "POST" && request.headers.get("origin") !== url2.origin) throw new AppError("Submit this request from the event website.", 403);
    const value = cookieValue(request, secure), user = auth.authenticate(value);
    const profile = user ? await store.exclusive(() => prepare(store.db, actor(user))) : null;
    const manager = canAdminister(profile);
    const requireUser = () => {
      if (!user) throw new AppError("Please sign in.", 401);
    };
    const requireAdmin = () => {
      if (!manager) throw new AppError("Administrator access is required.", 403);
    };
    const requireLocal = () => {
      if (!isLocal) throw new AppError("Open Host controls on the hosting PC.", 403);
    };
    const path = url2.pathname;
    if (path === "/api/health") return json({ ok: true, instanceId, ready: !!auth.ownerId() });
    if (path === "/host/setup") {
      requireLocal();
      if (auth.ownerId()) return redirect("/host");
      if (request.method === "GET") {
        if (url2.searchParams.get("token") !== setupToken) throw new AppError("Use the setup link displayed in the launcher.", 403);
        return formPage("setup");
      }
      const input = await fields(request);
      if (!input.setup_token || digest(input.setup_token) !== digest(setupToken)) throw new AppError("Invalid setup link.", 403);
      auth.limit("setup", 10);
      const owner = await hashing(() => auth.create(input, true));
      setupToken = token();
      await store.exclusive(() => prepare(store.db, actor(owner)));
      return redirect("/host", { "Set-Cookie": sessionCookie(auth.session(owner.id), secure) });
    }
    if (!auth.ownerId()) return page("Event setup", `<h1>The organiser is setting up ICT Big Day.</h1><p>Please check back shortly.</p>`);
    if (path === "/auth/signin" || path === "/auth/signup") {
      const mode2 = path.endsWith("signup") ? "signup" : "signin", returnTo = safeReturn(url2.searchParams.get("return_to"));
      if (request.method === "GET") return user ? redirect(returnTo) : formPage(mode2, returnTo);
      const input = await fields(request), email = String(input.email || "");
      const ip = isLocal ? "local" : request.headers.get("cf-connecting-ip") || "public";
      auth.limit("auth-ip:" + ip, 100);
      auth.limit(mode2 + ":" + email.trim().toLowerCase(), 12);
      const account = await hashing(() => mode2 === "signup" ? auth.create(input) : auth.login(email, input.password || ""));
      await store.exclusive(() => prepare(store.db, actor(account)));
      return redirect(safeReturn(input.return_to), { "Set-Cookie": sessionCookie(auth.session(account.id), secure) });
    }
    if (path === "/auth/signout") {
      if (request.method === "GET") return page("Sign out", `<h1>Sign out of ICT Big Day?</h1><form method="post">${field("return_to", "", "hidden", safeReturn(url2.searchParams.get("return_to")))}${submit("Sign out")}</form><p><a href="/">Keep me signed in</a></p>`);
      const input = await fields(request);
      auth.logout(value);
      return redirect(safeReturn(input.return_to), { "Set-Cookie": sessionCookie("", secure, true) });
    }
    if (path === "/auth/reset") {
      if (request.method === "GET") {
        if (!auth.resetValid(url2.searchParams.get("token"))) throw new AppError("This reset link has expired or was already used.");
        return formPage("reset", url2.searchParams.get("token"));
      }
      const input = await fields(request);
      auth.limit("reset:" + String(input.token).slice(0, 100), 8);
      await hashing(() => auth.changePassword(input.token, input.password));
      return redirect("/auth/signin");
    }
    if (path === "/api/attendance") return json({ stats: await store.exclusive(() => readAttendance(store.db)), updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    if (path === "/api/platform") {
      if (request.method === "GET") return json(await store.exclusive(() => profile ? readState(store.db, profile) : readPublicState(store.db)));
      requireUser();
      if (!request.headers.get("content-type")?.includes("application/json")) throw new AppError("Expected JSON.", 415);
      const input = await fields(request);
      return json(await store.exclusive(async () => act(store.db, await prepare(store.db, actor(user)), input)));
    }
    if (path === "/api/files" && request.method === "POST") {
      requireUser();
      if (!profile.registered_at) throw new AppError("Complete event registration before uploading.");
      const file = await readPdfUpload(request), id2 = crypto.randomUUID(), name = file.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180), key = id2 + ".pdf";
      writeFileSync(join2(files, key), Buffer.from(await file.arrayBuffer()), { flag: "wx", mode: 384 });
      try {
        await store.exclusive(() => store.db.prepare("INSERT INTO attachments (id,owner_id,name,object_key,size,created_at) VALUES (?,?,?,?,?,?)").bind(id2, user.id, name, key, file.size, (/* @__PURE__ */ new Date()).toISOString()).run());
      } catch (error) {
        unlinkSync(join2(files, key));
        throw error;
      }
      return json({ id: id2, name, size: file.size }, 201);
    }
    if (path.startsWith("/api/files/") && request.method === "GET") {
      const file = await store.exclusive(() => mayReadAttachment(store.db, path.slice(11), profile));
      if (!file || !/^[a-f0-9-]+\.pdf$/.test(file.object_key) || !existsSync(join2(files, file.object_key))) throw new AppError("Document not found.", 404);
      return new Response(readFileSync2(join2(files, file.object_key)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.name) } });
    }
    if (path === "/host/tunnel" && request.method === "POST") {
      requireLocal();
      requireAdmin();
      const input = await fields(request), publicUrl = validatePublicUrl(input.public_url), tunnelToken = String(input.tunnel_token || "").trim();
      if (!/^[A-Za-z0-9_+=\/-]{30,4096}$/.test(tunnelToken)) throw new AppError("Paste only the tunnel token from Cloudflare, not the whole command.");
      writeFileSync(join2(dataDir, "tunnel-token.txt"), tunnelToken, { mode: 384 });
      config = { publicUrl };
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 384 });
      return page("Tunnel saved", '<h1>Your fixed address is configured.</h1><p>Close the launcher, then run <strong>START-LIVE.cmd</strong>. It will connect the tunnel, check your public address and create the QR code.</p><p><a href="/host">Back to Host controls</a></p>');
    }
    if (path === "/host/accounts" && request.method === "POST") {
      requireAdmin();
      const input = await fields(request), target = auth.account(String(input.user_id));
      if (!target) throw new AppError("Account not found.", 404);
      if (input.action === "verify") {
        store.sql.prepare("UPDATE auth_users SET email_verified=1 WHERE id=?").run(target.id);
        return redirect("/host");
      }
      if (input.action === "reset") {
        const reset = auth.reset(target.id), link = (publicOrigin || localOrigin) + "/auth/reset?token=" + reset;
        return page("Password reset", `<h1>Password reset for ${escape(target.name)}</h1><p>Give this link only to the verified account holder. It expires in 30 minutes and works once.</p><textarea readonly rows="4">${escape(link)}</textarea><p><a href="/host">Back to Host controls</a></p>`);
      }
      throw new AppError("Unknown account action.");
    }
    if (path === "/host") {
      if (!user) return redirect("/auth/signin?return_to=%2Fhost");
      requireAdmin();
      const accounts = store.sql.prepare("SELECT id,email,name,email_verified FROM auth_users ORDER BY created_at DESC").all();
      const rows = accounts.map((account) => `<tr><td>${escape(account.name)}<small>${escape(account.email)}</small></td><td>${account.email_verified ? "Confirmed by organiser" : `<form action="/host/accounts" method="post">${field("user_id", "", "hidden", account.id)}${field("action", "", "hidden", "verify")}${submit("Confirm email ownership")}</form>`}</td><td><form action="/host/accounts" method="post">${field("user_id", "", "hidden", account.id)}${field("action", "", "hidden", "reset")}${submit("Password reset link")}</form></td></tr>`).join("");
      return page("Host controls", `<p class="eyebrow">WINDOWS HOSTING</p><h1>Your event, live from your PC.</h1><nav><a href="/portal/administrator">Administrator workspace</a><a href="/portal/organiser">Organiser workspace</a><a href="/">Event website</a><a href="/auth/signout">Sign out</a></nav><section><h2>Public link and QR code</h2>${publicOrigin ? `<p class="status">${publicVerified ? "Public address checked successfully" : "Public address has not passed its connection check yet"}</p><p><a href="${escape(publicOrigin)}" target="_blank" rel="noreferrer">${escape(publicOrigin)}</a></p><img class="qr" src="/host/qr.svg" alt="Event website QR code"><p><a href="/host/qr.svg" download="ICT-Big-Day-QR.svg">Download QR code</a></p><p>The <strong>share</strong> folder also contains the QR code, the link and a printable share page.</p>` : "<p>The website is running on this PC. A public tunnel is not connected yet.</p>"}<p>Keep this PC awake, online and connected to power. Keep the launcher window open.</p></section>${isLocal ? `<section><h2>Connect a fixed public address</h2><p>For event use, create a Cloudflare Tunnel and a public hostname pointing to <strong>${escape(localOrigin)}</strong>. See START-HERE.html for the steps. Paste its hostname and tunnel token below. The token stays on this PC.</p><form method="post" action="/host/tunnel">${field("public_url", "Public website address", "url", config.publicUrl || "", 'required placeholder="https://your-event.your-domain.org"')}${field("tunnel_token", "Cloudflare tunnel token", "password", "", 'required autocomplete="off"')}${submit("Save fixed address")}</form></section>` : ""}<section><h2>Event accounts</h2><p>Only confirm email ownership after checking the person through a trusted channel. Email-based staff grants remain inactive until confirmation. You can also grant a role directly to the correct existing account in the Administrator workspace.</p><div class="scroll"><table><thead><tr><th>Account</th><th>Email confirmation</th><th>Recovery</th></tr></thead><tbody>${rows}</tbody></table></div></section><p class="muted">This is a separate installation. The existing hosted website and its records are not copied into this database.</p>`);
    }
    if (path === "/host/qr.svg") {
      requireAdmin();
      if (!publicOrigin) throw new AppError("Connect the public link first.");
      return new Response(qrSvg(publicOrigin), { headers: { "Content-Type": "image/svg+xml", "Content-Disposition": 'attachment; filename="ICT-Big-Day-QR.svg"' } });
    }
    if (path === "/" || path.startsWith("/portal/")) {
      if (path.startsWith("/portal/")) {
        if (!portals[path.split("/")[2]] || path.split("/").length !== 3) throw new AppError("Workspace not found.", 404);
        if (!user) return redirect("/auth/signin?return_to=" + encodeURIComponent(path));
      }
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="ICT Big Day 2026 at the University of Mpumalanga. Make your participation count."><title>ICT Big Day 2026 \xB7 Make your participation count</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const assets = { "/assets/app.js": ["assets/app.js", "text/javascript; charset=utf-8"], "/assets/app.css": ["assets/app.css", "text/css; charset=utf-8"], "/assets/host.css": ["assets/host.css", "text/css; charset=utf-8"], "/favicon.svg": ["favicon.svg", "image/svg+xml"], "/ict-big-day-draft-programme.docx": ["ict-big-day-draft-programme.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] };
    if (assets[path] && request.method === "GET") {
      const [file, mime] = assets[path];
      return new Response(readFileSync2(join2(root2, "public", file)), { headers: { "Content-Type": mime } });
    }
    throw new AppError("Page not found.", 404);
  }
  async function handle(request) {
    let response;
    try {
      response = await route(request);
    } catch (error) {
      const status = error instanceof AppError ? error.status : Number(error.status) || 500;
      const message = status < 500 ? error.message : "We could not complete this request. Please try again.";
      if (status >= 500) console.error("Event request failed:", error.message);
      response = new URL(request.url).pathname.startsWith("/api/") ? json({ error: message }, status) : page("Please try again", `<h1>${escape(message)}</h1><p><a href="/auth/signin">Return to sign in</a></p><p><a href="/">Go to the event website</a></p>`);
      if (!new URL(request.url).pathname.startsWith("/api/")) response = new Response(response.body, { status, headers: response.headers });
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  }
  return { handle, store, auth, config: () => config, hostStatus, setPublicUrl, markVerified: () => {
    publicVerified = true;
  }, shareFiles, setupUrl: () => localOrigin + "/host/setup?token=" + setupToken, localOrigin, dataDir, close: () => store.close() };
}

// source/start.mjs
var root = dirname(fileURLToPath(import.meta.url));
var mode = process.argv.includes("--live") ? "live" : process.argv.includes("--trial") ? "trial" : "local";
var app = await createEventApp({ root });
var tunnel = null;
var closing = false;
function open2(url2) {
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url2], { stdio: "ignore", detached: true }).unref();
}
var server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || "";
    const publicUrl = app.hostStatus().publicUrl;
    const base = host === "127.0.0.1:3000" ? app.localOrigin : publicUrl && host === new URL(publicUrl).host ? publicUrl : null;
    if (!base) {
      res.writeHead(421);
      res.end("Unknown website address");
      return;
    }
    const request = new Request(new URL(req.url, base), { method: req.method, headers: req.headers, ...!["GET", "HEAD"].includes(req.method) ? { body: Readable.toWeb(req), duplex: "half" } : {} });
    const response = await app.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    console.error("Request could not finish:", error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end("Request could not finish.");
  }
});
server.headersTimeout = 15e3;
server.requestTimeout = 3e4;
server.maxHeadersCount = 80;
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? "Port 3000 is already in use. Close the other event launcher before trying again." : error.message);
  process.exitCode = 1;
  app.close();
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(3e3, "127.0.0.1", resolve);
}).catch(() => process.exit(1));
console.log("\nICT BIG DAY 2026 \u2014 WINDOWS HOST\n");
console.log("Local website: " + app.localOrigin);
console.log("Host controls: " + app.localOrigin + "/host");
console.log("Keep this window open while people use the website. Press Ctrl+C to stop.\n");
if (!app.hostStatus().initialised) {
  console.log("Create your administrator using this one-time setup link:\n" + app.setupUrl() + "\n");
  open2(app.setupUrl());
} else open2(app.localOrigin + "/host");
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForOwner() {
  while (!closing && !app.hostStatus().initialised) await delay(1e3);
  return !closing;
}
function cloudflaredPath() {
  const bundled = join3(root, "tools", "cloudflared.exe");
  if (existsSync2(bundled)) return bundled;
  const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"], { encoding: "utf8", windowsHide: true });
  return located.status === 0 ? located.stdout.trim().split(/\r?\n/)[0] : null;
}
async function verifyPublic(url2) {
  console.log("Temporary public address: " + url2);
  console.log("Checking the public address from this PC (this can take a few minutes)...");
  let lastError = "";
  for (let i = 0; i < 80 && !closing; i++) {
    if (tunnel?.exitCode !== null && tunnel?.exitCode !== void 0) break;
    try {
      const response = await fetch(url2 + "/api/health", { signal: AbortSignal.timeout(5e3), redirect: "error" });
      const health = await response.json();
      if (response.ok && health.instanceId === app.hostStatus().instanceId && health.ready) {
        app.markVerified();
        app.shareFiles(url2);
        console.log("\nPUBLIC WEBSITE: " + url2 + "\nQR CODE: " + join3(root, "share", "ICT-Big-Day-QR.svg") + "\nSHARE PAGE: " + join3(root, "share", "SHARE.html") + "\n");
        console.log(mode === "trial" ? "Temporary test link. A new tunnel creates a different link and QR code. Use a fixed address for the event." : "Your fixed public address passed its connection check. Test it on a phone using mobile data.");
        open2(app.localOrigin + "/host");
        return true;
      }
      lastError = "unexpected reply (status " + response.status + ")";
    } catch (error) {
      lastError = (error?.cause?.code || error?.cause?.message || error?.message || String(error));
    }
    if (i % 5 === 4) console.log("Still checking... last problem: " + lastError);
    await delay(2e3);
  }
  console.error("\nLast problem: " + lastError + "\nThe address was: " + url2 + "\nIf the problem is a DNS/name lookup error, this PC may not see the new address yet. Try opening that address on a phone using mobile data.");
  if (process.argv.includes("--share-anyway")) {
    app.shareFiles(url2);
    console.log("\nUNCHECKED share files were created in: " + join3(root, "share") + "\nTest the link on a phone with mobile data BEFORE sharing it.");
    return true;
  }
  console.error("The public connection could not be verified. The local website is still running. Check the tunnel settings and internet connection, then restart this launcher. A new share QR has not been created.");
  return false;
}
if (mode !== "local") {
  if (await waitForOwner()) {
    const binary = cloudflaredPath();
    if (!binary) console.error("cloudflared is missing. Open START-HERE.html and install it, or place cloudflared.exe inside the tools folder. The website is available locally.");
    else if (mode === "live" && (!app.config().publicUrl || !existsSync2(join3(app.dataDir, "tunnel-token.txt")))) console.error("A fixed tunnel has not been configured. Open Host controls and save your public HTTPS address and tunnel token, then restart START-LIVE.cmd. Use START-TRIAL-LINK.cmd only for a temporary test.");
    else {
      const argumentsList = mode === "live" ? ["tunnel", "--no-autoupdate", "run", "--token-file", join3(app.dataDir, "tunnel-token.txt")] : ["tunnel", "--no-autoupdate", "--url", app.localOrigin];
      const tunnelDirectory = join3(root, "tools");
      mkdirSync3(tunnelDirectory, { recursive: true });
      tunnel = spawn(binary, argumentsList, { cwd: tunnelDirectory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let found = false, pending = "", logs = "";
      const observe = (bytes) => {
        const text2 = bytes.toString();
        logs = (logs + text2).slice(-16e3);
        pending = (pending + text2).slice(-8e3);
        if (mode === "trial" && !found) {
          const match = pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
          if (match) {
            found = true;
            const url2 = app.setPublicUrl(match[0]);
            void verifyPublic(url2);
          }
        }
        if (/Registered tunnel connection/.test(text2)) console.log("Tunnel connected.");
      };
      tunnel.stdout.on("data", observe);
      tunnel.stderr.on("data", observe);
      tunnel.on("error", (error) => console.error("Could not start cloudflared: " + error.message));
      tunnel.on("exit", (code) => {
        if (!closing) {
          console.error("The public tunnel stopped (code " + code + "). The website is still available locally. Restart the launcher to reconnect.");
        }
      });
      if (mode === "live") {
        app.setPublicUrl(app.config().publicUrl);
        void verifyPublic(app.config().publicUrl);
      } else {
        console.log("Creating a temporary test tunnel...");
        setTimeout(() => {
          if (!found && !closing) console.error("No temporary link was received. Check that cloudflared can connect. A pre-existing cloudflared config.yml can prevent Quick Tunnels; see START-HERE.html.");
        }, 3e4).unref();
      }
    }
  }
}
async function stop() {
  if (closing) return;
  closing = true;
  console.log("\nStopping the public connection and website...");
  tunnel?.kill();
  server.close(async () => {
    app.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5e3).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
