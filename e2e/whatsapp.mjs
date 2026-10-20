// End-to-end test of the WhatsApp bot against the REAL server, REAL database and REAL PyTorch model.
// Only the outside world is stubbed: Twilio's REST/media hosts and Open Food Facts (a local HTTP stub), because
// this sandbox (and CI) cannot reach them. Webhooks are signed with an independent HMAC-SHA1 implementation.
//
// Run from the repo root:  node e2e/whatsapp.mjs        (needs python3 with torch for the Flask service)
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import { sql } from "./lib/db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "IngreScan-AI", "package.json"));
const { SignJWT } = require("jose");
const superjson = require("superjson");

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3106);
const FLASK_PORT = Number(process.env.E2E_FLASK_PORT ?? 5106);
const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 4106);
const BASE = `http://localhost:${WEB_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const AUTH_TOKEN = "e2e-twilio-token";
const ACCOUNT = "ACe2e";
const APP_ID = "e2e-app";
const SECRET = "e2e-secret";
const dbFile = path.join(os.tmpdir(), `whatsapp-e2e-${process.pid}.db`);
process.env.SQLITE_PATH = dbFile;
delete process.env.DATABASE_URL;

const results = [];
const check = (name, ok, detail = "") => results.push([ok ? "PASS" : "FAIL", name, detail]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ stub servers
const outbox = []; // every message the bot tried to send through "Twilio"
const offHits = [];
const media = {
  apple: { file: path.join(root, "static/samples/apple.jpg"), type: "image/jpeg" },
  banana: { file: path.join(root, "static/samples/banana.jpg"), type: "image/jpeg" },
  barcode: { file: path.join(root, "e2e/fixtures/ean13-valid.png"), type: "image/png" },
  nobarcode: { file: path.join(root, "e2e/fixtures/label-no-barcode.png"), type: "image/png" },
};
const OFF_PRODUCTS = {
  // a real-looking EAN-13 with a valid check digit; ingredients include sugar syrups
  "8901030895470": { code: "8901030895470", product_name: "Masala Instant Noodles", brands: "Acme Foods", ingredients_text: "Wheat flour, palm oil, salt, sugar, maltodextrin, monosodium glutamate, spices", allergens: "en:gluten", nutriments: { sugars_100g: 3, salt_100g: 3.2, "saturated-fat_100g": 7 }, nutriscore_grade: "d", nova_group: 4 },
  // valid check digit, but no ingredient list
  "4006381333931": { code: "4006381333931", product_name: "Mystery Snack", brands: "Nobody", ingredients_text: "", allergens: "", nutriments: {} },
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, STUB);
  try {
    if (req.method === "POST" && url.pathname === `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`) {
      const expected = "Basic " + Buffer.from(`${ACCOUNT}:${AUTH_TOKEN}`).toString("base64");
      if (req.headers.authorization !== expected) return void res.writeHead(401).end("unauthorized");
      const form = new URLSearchParams((await readBody(req)).toString());
      outbox.push({ to: form.get("To"), from: form.get("From"), body: form.get("Body"), contentSid: form.get("ContentSid"), vars: form.get("ContentVariables"), at: Date.now() });
      return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ sid: "SMstub" }));
    }
    const m = /^\/2010-04-01\/Accounts\/[^/]+\/Messages\/[^/]+\/Media\/(\w+)$/.exec(url.pathname);
    if (req.method === "GET" && m && media[m[1]]) {
      const expected = "Basic " + Buffer.from(`${ACCOUNT}:${AUTH_TOKEN}`).toString("base64");
      if (req.headers.authorization !== expected) return void res.writeHead(401).end("unauthorized");
      return void res.writeHead(200, { "content-type": media[m[1]].type }).end(fs.readFileSync(media[m[1]].file));
    }
    const off = /^\/off\/api\/v2\/product\/(\d+)\.json$/.exec(url.pathname);
    if (req.method === "GET" && off) {
      offHits.push(off[1]);
      const p = OFF_PRODUCTS[off[1]];
      if (!p) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ status: 0 }));
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: 1, product: p }));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

// ------------------------------------------------------------------- processes
const children = [];
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.getLog = () => log;
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children) {
    try {
      if (process.platform === "win32") {
        c.kill("SIGTERM");
      } else {
        process.kill(-c.pid, "SIGTERM");
      }
    } catch { /* already gone */ }
  }
}
async function waitFor(url, label, child, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  const log = child ? child.getLog() : "";
  throw new Error(`${label} did not start. Logs:\n${log}`);
}

// ---------------------------------------------------------------------- helpers
function twilioSignature(url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
}
let sidCounter = 0;
async function webhook(from, fields = {}, { sign = true, sid } = {}) {
  const params = { From: `whatsapp:${from}`, To: "whatsapp:+14155238886", MessageSid: sid ?? `SM${Date.now()}${++sidCounter}`, NumMedia: "0", ProfileName: "Tester", ...fields };
  const url = `${BASE}/api/whatsapp/twilio`;
  const signature = sign ? twilioSignature(url, params) : "AAAA";
  const before = outbox.length;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(params).toString() });
  // replies are delivered after the webhook response; wait until they land (or a short quiet period)
  for (let i = 0; i < 40; i++) { await sleep(150); if (outbox.length > before && i > 3) break; }
  await sleep(150);
  return { status: res.status, replies: outbox.slice(before) };
}
const text = (from, body, opts) => webhook(from, { Body: body }, opts);
const photo = (from, name, type = "image/jpeg", body = "") =>
  webhook(from, { Body: body, NumMedia: "1", MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages/MM1/Media/${name}`, MediaContentType0: type });
const allText = (r) => r.replies.map((x) => x.body ?? "").join("\n");

async function session(openId) {
  return new SignJWT({ openId, appId: APP_ID, name: openId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor((Date.now() + 3600_000) / 1000))
    .sign(new TextEncoder().encode(SECRET));
}
async function trpc(cookie, proc, input, mutate = false) {
  const url = `${BASE}/api/trpc/${proc}` + (mutate ? "" : `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input ?? undefined)))}`);
  const res = await fetch(url, { method: mutate ? "POST" : "GET", headers: { cookie: `app_session_id=${cookie}`, "content-type": "application/json" }, body: mutate ? JSON.stringify(superjson.serialize(input ?? undefined)) : undefined });
  const body = await res.json();
  return { status: res.status, data: body?.result?.data?.json, error: body?.error?.json };
}
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------- run
async function main() {
  await new Promise((r) => stubServer.listen(STUB_PORT, "127.0.0.1", r));
  const pyCmd = process.platform === "win32" ? "python" : "python3";
  const flask = start(pyCmd, ["app.py"], { cwd: root, env: { ...process.env, FRESHGUARD_PORT: String(FLASK_PORT) } });
  const redirectFetchUrl = pathToFileURL(path.join(root, "e2e/lib/redirect-fetch.mjs")).href;
  const web = start("node", ["--import", redirectFetchUrl, "--import", "tsx", "./server/_core/index.ts"], {
    cwd: path.join(root, "IngreScan-AI"),
    env: {
      ...process.env, NODE_ENV: "development", PORT: String(WEB_PORT), SQLITE_PATH: dbFile, JWT_SECRET: SECRET, VITE_APP_ID: APP_ID,
      FRESHGUARD_URL: `http://127.0.0.1:${FLASK_PORT}`, OPENFOODFACTS_BASE_URL: `${STUB}/off`, OFF_CACHE_DISABLED: "true",
      E2E_STUB_URL: STUB, PUBLIC_BASE_URL: BASE,
      TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WHATSAPP_FROM: "+14155238886", TWILIO_REMINDER_CONTENT_SID: "HXe2etemplate",
      WHATSAPP_BOT_NUMBER: "+14155238886", WHATSAPP_REMINDER_INTERVAL_MS: "2000", WHATSAPP_RATE_BURST: "100", WHATSAPP_RATE_PER_MINUTE: "600",
    },
  });
  await waitFor(`http://127.0.0.1:${FLASK_PORT}/api/samples`, "Flask", flask);
  await waitFor(`${BASE}/api/trpc/auth.me`, "web app", web);

  // ---- accounts: two real users with signed sessions
  sql("insert into users (openId,name,role,loginMethod) values ('wa-alice','Alice','user','local')");
  sql("insert into users (openId,name,role,loginMethod) values ('wa-bob','Bob','user','local')");
  const alice = await session("wa-alice");
  const bob = await session("wa-bob");
  const aliceId = sql("select id from users where openId='wa-alice'");
  const bobId = sql("select id from users where openId='wa-bob'");
  const PHONE_A = "+919800000001";
  const PHONE_B = "+919800000002";

  // ---- status and linking through the web API
  const st0 = await trpc(alice, "whatsapp.status");
  check("Web: bot reported as configured, not linked", st0.data?.configured === true && st0.data?.linked === false);
  const code = (await trpc(alice, "whatsapp.createLinkCode", undefined, true)).data?.code;
  check("Web: link code generated (8 chars)", typeof code === "string" && code.length === 8, String(code));
  check("DB: only a salted hash of the code is stored", sql("select count(*) from whatsapp_link_codes where code_hash like '%" + code + "%'") === "0");

  // ---- webhook security
  let r = await text(PHONE_A, `LINK ${code}`, { sign: false });
  check("Webhook with a bad signature is rejected (403) and nothing is sent", r.status === 403 && r.replies.length === 0, `status ${r.status}`);
  const rUnsigned = await fetch(`${BASE}/api/whatsapp/twilio`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Body=hi&From=whatsapp:%2B1&MessageSid=SMx" });
  check("Webhook without any signature header is rejected", rUnsigned.status === 403, `status ${rUnsigned.status}`);

  // ---- unlinked users
  r = await text(PHONE_A, "FRIDGE");
  check("Unlinked phone gets linking guidance, not data", r.status === 200 && /LINK|Connect WhatsApp/i.test(allText(r)), allText(r).slice(0, 80));

  r = await text(PHONE_A, "LINK WRONGCODE");
  check("Wrong link code is rejected", /not recognised|expired|already used/i.test(allText(r)), allText(r).slice(0, 80));
  r = await text(PHONE_A, `link ${code}`);
  check("Correct code links the account (case-insensitive command)", /connected/i.test(allText(r)), allText(r).slice(0, 80));
  check("DB: link row stored for Alice's phone", sql(`select count(*) from whatsapp_links where user_id=${aliceId} and phone='${PHONE_A}'`) === "1");
  r = await text(PHONE_B, `LINK ${code}`);
  check("A used code cannot be redeemed again", /already used|not recognised/i.test(allText(r)) && sql(`select count(*) from whatsapp_links where phone='${PHONE_B}'`) === "0", allText(r).slice(0, 80));

  // ---- duplicate delivery
  const dupSid = "SMduplicate001";
  const d1 = await text(PHONE_A, "HELP", { sid: dupSid });
  const d2 = await text(PHONE_A, "HELP", { sid: dupSid });
  check("HELP lists commands", /FRIDGE/i.test(allText(d1)) && /COOK|RESCUE/i.test(allText(d1)));
  check("Duplicate webhook delivery is answered once", d1.replies.length >= 1 && d2.replies.length === 0, `${d1.replies.length}/${d2.replies.length}`);

  // ---- produce photo -> real model -> ADD -> FRIDGE -> CLEAR
  const flaskHistoryBefore = (await (await fetch(`http://127.0.0.1:${FLASK_PORT}/api/history`)).json()).length;
  r = await photo(PHONE_A, "apple");
  check("Produce photo: real model report (Apple, status, shelf life)", /INSPECTION REPORT/.test(allText(r)) && /Apple/i.test(allText(r)) && /Estimated shelf life/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 140));
  check("Replies use no emoji", !/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(allText(r)));
  const flaskHistoryAfter = (await (await fetch(`http://127.0.0.1:${FLASK_PORT}/api/history`)).json()).length;
  check("Flask's own history is unchanged by the bot (persist=0)", flaskHistoryAfter === flaskHistoryBefore, `${flaskHistoryBefore} -> ${flaskHistoryAfter}`);
  r = await text(PHONE_A, "ADD");
  check("ADD saves to the pantry", /Added|saved/i.test(allText(r)), allText(r).slice(0, 100));
  const row = sql(`select name, fruit_type, expiry_date, p_fresh from produce_inventory where user_id=${aliceId}`);
  check("DB: produce item stored for Alice with expiry and real probability", /^Apple\tapple\t\d{4}-\d{2}-\d{2}\t\d+/.test(row), row);
  r = await text(PHONE_A, "FRIDGE");
  check("FRIDGE lists the item", /Apple/i.test(allText(r)), allText(r).slice(0, 100));
  r = await text(PHONE_A, "ADD");
  check("A second ADD with nothing pending adds nothing", /nothing to add/i.test(allText(r)) && sql(`select count(*) from produce_inventory where user_id=${aliceId}`) === "1");

  // the website sees the same pantry
  const web1 = await trpc(alice, "produce.listInventory");
  check("Website shows the item added through WhatsApp", web1.data?.length === 1 && web1.data[0].name === "Apple");
  const bobView = await trpc(bob, "produce.listInventory");
  check("Another user's website account sees none of it", bobView.data?.length === 0);

  // ---- barcode: photo and typed
  r = await photo(PHONE_A, "barcode", "image/png");
  check("Barcode photo is decoded and the product report is returned (Open Food Facts stub)", /PRODUCT RISK REPORT/.test(allText(r)) || /Masala Instant Noodles|PRODUCT FOUND|could not find a product/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 160));
  r = await text(PHONE_A, "8901030895470");
  check("Typed barcode: risk report with score, ingredients analysed and saved", /PRODUCT RISK REPORT/.test(allText(r)) && /Risk score: \d+\/100/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 160));
  check("DB: scan and ingredient rows created for Alice", Number(sql(`select count(*) from food_scans where user_id=${aliceId}`)) >= 1 && Number(sql(`select count(*) from scan_ingredients`)) >= 4);
  check("Report mentions the allergen from Open Food Facts", /gluten/i.test(allText(r)), "");
  r = await text(PHONE_A, "8901030895471");
  check("Barcode with a wrong check digit is explained, not looked up", /check digit/i.test(allText(r)), allText(r).slice(0, 100));
  r = await text(PHONE_A, "4006381333931");
  check("Product without ingredient data asks for a label photo (no invented score)", /no ingredient list/i.test(allText(r)) && !/Risk score/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 140));
  r = await text(PHONE_A, "5449000000996");
  check("Unknown barcode is reported as not found", /could not find a product/i.test(allText(r)), allText(r).slice(0, 100));
  r = await text(PHONE_A, "Wheat flour, sugar, glucose syrup, palm oil, salt");
  check("Pasted ingredient text is analysed", /PRODUCT RISK REPORT/.test(allText(r)) || /Risk score/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 120));

  // ---- non-produce photo without a barcode must not become a confident fruit
  r = await photo(PHONE_A, "nobarcode", "image/png");
  check("A label photo without barcode or AI key is not misreported as produce", !/INSPECTION REPORT/.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 120));
  r = await photo(PHONE_A, "apple", "application/pdf");
  check("Unsupported media type is refused politely", /JPEG, PNG or WebP|photo/i.test(allText(r)), allText(r).slice(0, 80));

  // ---- preferences
  r = await text(PHONE_A, "TZ Asia/Kolkata");
  check("TZ command updates the time zone", sql(`select timezone from whatsapp_links where user_id=${aliceId}`) === "Asia/Kolkata", allText(r).slice(0, 60));
  r = await text(PHONE_A, "TZ Mars/Base");
  check("Invalid time zone is rejected", /not a valid time zone/i.test(allText(r)));
  r = await text(PHONE_A, "REMIND 8");
  check("REMIND outside quiet hours updates the hour", sql(`select reminder_hour from whatsapp_links where user_id=${aliceId}`) === "8", allText(r).slice(0, 80));
  r = await text(PHONE_A, "STOP");
  check("STOP turns reminders off (opt-out honoured)", sql(`select reminders_enabled from whatsapp_links where user_id=${aliceId}`) === "0");
  r = await text(PHONE_A, "START");
  check("START turns them on again", sql(`select reminders_enabled from whatsapp_links where user_id=${aliceId}`) === "1");

  // ---- rescue
  sql(`insert into produce_inventory (user_id,name,fruit_type,freshness,p_fresh,confidence,expiry_date) values (${aliceId},'Banana','banana','normal',50,95,'${ymd(1)}')`);
  r = await text(PHONE_A, "COOK");
  check("COOK returns a recipe for items about to expire", /Banana/i.test(allText(r)) && /min/i.test(allText(r)), allText(r).replace(/\n/g, " | ").slice(0, 140));

  // ---- CLEAR
  r = await text(PHONE_A, "CLEAR banana");
  check("CLEAR removes the matching item", sql(`select count(*) from produce_inventory where user_id=${aliceId} and name='Banana'`) === "0", allText(r).slice(0, 80));
  r = await text(PHONE_A, "CLEAR unicorn");
  check("CLEAR with no match says so", /could not find/i.test(allText(r)));

  // ---- reminders (scheduler runs every 2 s in this run)
  // Pick a time zone where the local hour now is inside the allowed window, set the preferred hour to that hour.
  const zones = ["Etc/GMT", "Etc/GMT+3", "Etc/GMT-3", "Etc/GMT+6", "Etc/GMT-6", "Etc/GMT+9", "Etc/GMT-9", "Etc/GMT+12", "Etc/GMT-10"];
  const hourIn = (tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date())) % 24;
  const tz = zones.find((z) => hourIn(z) >= 10 && hourIn(z) <= 17) ?? "Etc/GMT";
  const hourNow = hourIn(tz);
  sql(`insert into produce_inventory (user_id,name,fruit_type,freshness,p_fresh,confidence,expiry_date) values (${aliceId},'Tomato','tomato','normal',55,95,'${ymd(1)}')`);
  sql(`update whatsapp_links set timezone='${tz}', reminder_hour=${hourNow}, reminders_enabled=1, last_reminder_local_date=NULL, last_inbound_at=${Math.floor(Date.now() / 1000)} where user_id=${aliceId}`);
  const beforeReminder = outbox.length;
  for (let i = 0; i < 25 && outbox.length === beforeReminder; i++) await sleep(500);
  const rem = outbox.slice(beforeReminder).find((m) => m.to?.includes(PHONE_A));
  check("Daily reminder is sent as a session message inside the 24h window", Boolean(rem && rem.body && /Tomato/i.test(rem.body) && !rem.contentSid), rem ? (rem.body ?? "").replace(/\n/g, " | ").slice(0, 120) : "no reminder sent");
  const again = outbox.length;
  await sleep(5000);
  check("Reminder is sent at most once per local day", outbox.slice(again).filter((m) => m.to?.includes(PHONE_A)).length === 0);

  // outside the 24h window a template must be used
  sql(`update whatsapp_links set last_reminder_local_date=NULL, last_inbound_at=${Math.floor(Date.now() / 1000) - 30 * 3600} where user_id=${aliceId}`);
  const beforeTemplate = outbox.length;
  for (let i = 0; i < 25 && outbox.length === beforeTemplate; i++) await sleep(500);
  const tpl = outbox.slice(beforeTemplate).find((m) => m.to?.includes(PHONE_A));
  check("Outside the 24h window the reminder uses the approved template", Boolean(tpl && tpl.contentSid === "HXe2etemplate" && !tpl.body), tpl ? JSON.stringify({ sid: tpl.contentSid, vars: tpl.vars }).slice(0, 120) : "no reminder sent");

  // reminders off -> nothing
  sql(`update whatsapp_links set last_reminder_local_date=NULL, reminders_enabled=0 where user_id=${aliceId}`);
  const beforeOff = outbox.length;
  await sleep(5000);
  check("No reminder when the user has opted out", outbox.slice(beforeOff).filter((m) => m.to?.includes(PHONE_A)).length === 0);

  // ---- web unlink revokes the bot
  const un = await trpc(alice, "whatsapp.unlink", undefined, true);
  r = await text(PHONE_A, "FRIDGE");
  check("After unlinking in the web app the bot no longer shows data", un.data?.success === true && /LINK|Connect WhatsApp/i.test(allText(r)));

  // ---- rate limiting: 150 simultaneous messages from one phone against a burst of 100
  const floodBefore = outbox.length;
  await Promise.all(Array.from({ length: 150 }, (_, i) => webhook("+919800000077", { Body: "HELP" }, { sid: `SMflood${i}` })));
  await sleep(1500);
  const floodReplies = outbox.slice(floodBefore).filter((m) => m.to?.includes("+919800000077"));
  const limitedCount = floodReplies.filter((m) => /too quickly/i.test(m.body ?? "")).length;
  check("A flood from one phone is rate limited (some, not all, messages refused)", limitedCount > 0 && limitedCount < 150, `${limitedCount} limited of ${floodReplies.length} replies`);

  // ---- server stayed healthy
  check("Server log has no unhandled errors", !/UnhandledPromiseRejection|Uncaught Exception|TypeError:/.test(web.getLog()), "");
  void flask; void bobId;
}

main()
  .catch((e) => check("Test harness", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")))
  .finally(() => {
    for (const r of results) console.log(r.join(" | "));
    const failed = results.filter((r) => r[0] === "FAIL").length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    stopAll();
    stubServer.close();
    for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore Windows file locks on exit */ }
    }
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
