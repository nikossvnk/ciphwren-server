// Checks a running test server the way a client uses it, with the real Etebase client.
// It needs a server that allows signing up, like the test-server image:
//   npm install --prefix tests/smoke && node tests/smoke/smoke.js http://127.0.0.1:3735
const http = require("http");
const Etebase = require("etebase");

const serverUrl = process.argv[2] || "http://127.0.0.1:3735";
const colType = "smoke.test";
// With INTERNAL_API_SECRET set (the server's ETEBASE_INTERNAL_API_SECRET) the internal API is checked too;
// without it, the internal API must not exist
const internalSecret = process.env.INTERNAL_API_SECRET;
// With DASHBOARD_URL and DASHBOARD_TICKET_SECRET set (as the server's ETEBASE_ ones) the dashboard link is checked
const dashboardSecret = process.env.DASHBOARD_TICKET_SECRET;

function check(what, condition) {
  if (!condition) {
    throw new Error(`Check failed: ${what}`);
  }
  console.log(`ok - ${what}`);
}

async function rejects(what, error, promise) {
  try {
    await promise;
  } catch (e) {
    // Without an error to expect any error will do
    check(what, !error || (e instanceof error));
    return;
  }
  throw new Error(`Check failed: ${what} (it was not rejected)`);
}

(async () => {
  const username = `smoke${Date.now()}`;
  const password = "a password for the smoke test";

  const signedUp = await Etebase.Account.signup({ username, email: `${username}@example.com` }, password, serverUrl);
  check("sign up", signedUp.user.username === username);
  await signedUp.logout();

  await rejects("log in with a wrong password is rejected", Etebase.UnauthorizedError,
    Etebase.Account.login(username, "not the password", serverUrl));

  const etebase = await Etebase.Account.login(username, password, serverUrl);
  check("log in", etebase.user.username === username);

  const colMgr = etebase.getCollectionManager();
  const col = await colMgr.create(colType, { name: "Smoke test" }, "");
  await colMgr.upload(col);
  const collections = await colMgr.list(colType);
  check("create and list a collection", collections.data.some((x) => x.uid === col.uid));
  const fetchedCol = await colMgr.fetch(col.uid);
  check("fetch a collection", fetchedCol.getMeta().name === "Smoke test");

  const itemMgr = colMgr.getItemManager(col);
  const item = await itemMgr.create({ name: "An item" }, "first");
  await itemMgr.batch([item]);
  let items = await itemMgr.list();
  check("create and list an item", (items.data.length === 1) && (items.data[0].uid === item.uid));
  check("the content of the item", (await items.data[0].getContent(Etebase.OutputFormat.String)) === "first");

  // Change it in two places, the second change has to be detected as a conflict
  const stale = itemMgr.cacheLoad(itemMgr.cacheSave(item));
  await item.setContent("second");
  await itemMgr.transaction([item]);
  const fetched = await itemMgr.fetch(item.uid);
  check("change an item", (await fetched.getContent(Etebase.OutputFormat.String)) === "second");
  await stale.setContent("conflicting");
  await rejects("a conflicting change is rejected", Etebase.ConflictError, itemMgr.transaction([stale]));

  const changes = await itemMgr.list({ stoken: items.stoken });
  check("list the changes since a sync token", (changes.data.length === 1) && (changes.stoken !== items.stoken));

  const revisions = await itemMgr.itemRevisions(item);
  check("list the revisions of an item", revisions.data.length === 2);

  item.delete();
  await itemMgr.batch([item]);
  items = await itemMgr.list();
  check("delete an item", items.data[0].isDeleted);

  // Changes at the same time, which SQLite used to fail with "database is locked": a transaction that
  // read first couldn't start writing while another one was writing
  const concurrent = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const concurrentCol = await colMgr.create(colType, { name: `Concurrent ${i}` }, "");
    await colMgr.upload(concurrentCol);
    const concurrentItemMgr = colMgr.getItemManager(concurrentCol);
    await concurrentItemMgr.batch([await concurrentItemMgr.create({ name: `Concurrent item ${i}` }, `content ${i}`)]);
    return concurrentCol.uid;
  }));
  const afterConcurrent = await colMgr.list(colType);
  check("make changes at the same time", concurrent.every((uid) => afterConcurrent.data.some((x) => x.uid === uid)));
  const lastConcurrent = await colMgr.fetch(concurrent[9]);
  const lastConcurrentItems = await colMgr.getItemManager(lastConcurrent).list();
  check("the content of an item changed at the same time",
    (await lastConcurrentItems.data[0].getContent(Etebase.OutputFormat.String)) === "content 9");

  // Requests that used to make the server fail with an internal error
  const api = `${serverUrl}/api/v1`;
  const status = async (path, options) => (await fetch(api + path, options)).status;
  check("a malformed Authorization header is rejected",
    (await status(`/collection/${col.uid}/item/`, { headers: { Authorization: "Token" } })) === 401);
  for (const uid of ["..", "....", "..AAAAAAAAAAAAAAAAAAAAAAAAAA", "A".repeat(61)]) {
    const code = await status(`/collection/${col.uid}/item/${item.uid}/chunk/${uid}/`, {
      method: "PUT",
      headers: { Authorization: `Token ${etebase.authToken}`, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    check(`a chunk with the uid ${JSON.stringify(uid.slice(0, 30))} is rejected`, (code === 400) || (code === 404));
  }

  const validChunk = await status(`/collection/${col.uid}/item/${item.uid}/chunk/${"C".repeat(43)}/`, {
    method: "PUT",
    headers: { Authorization: `Token ${etebase.authToken}`, "Content-Type": "application/octet-stream" },
    body: "x",
  });
  check("a chunk with a valid uid is accepted", validChunk === 201);

  // Other sites may use the API, but not the admin site
  const origin = "https://other.example";
  const preflight = await fetch(`${api}/collection/list_multi/`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
  });
  check("other sites may use the API", preflight.headers.get("access-control-allow-origin") === origin);
  const admin = await fetch(`${serverUrl}/admin/login/`, { headers: { Origin: origin } });
  check("other sites may not use the admin site", admin.headers.get("access-control-allow-origin") === null);

  // The pages for visitors with a browser: a neutral page that search engines don't index
  const home = await fetch(`${serverUrl}/`);
  const homeText = await home.text();
  check("the main page says what the server is",
    (home.status === 200) && homeText.includes("<h1>Etebase server</h1>") && !homeText.includes("It works"));
  check("the main page has no links", !homeText.includes("<a "));
  check("the main page is not indexed", homeText.includes('<meta name="robots" content="noindex, nofollow">'));
  const robots = await fetch(`${serverUrl}/robots.txt`);
  check("robots.txt keeps search engines out",
    (robots.status === 200) && (await robots.text()) === "User-agent: *\nDisallow: /\n");
  // The test server is in debug mode, where the API documentation is served
  const openapi = await fetch(`${serverUrl}/openapi.json`);
  check("the API documentation is served in debug mode",
    (openapi.status === 200) && ("/api/v1/authentication/is_etebase/" in (await openapi.json()).paths));

  const members = await colMgr.getMemberManager(col).list();
  check("list the members of a collection", (members.data.length === 1) && (members.data[0].username === username));

  const invitations = await etebase.getInvitationManager().listIncoming();
  check("list the invitations", invitations.data.length === 0);

  await etebase.fetchToken();
  check("refresh the login token", true);

  await etebase.logout();
  await rejects("requests after logging out are rejected", undefined, colMgr.list(colType));

  await checkLoginSlowdown();
  await checkInternalApi(`${username}@example.com`);

  console.log("All checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Forwards requests to the server and keeps the last body sent to each path
function startRecordingProxy(bodies) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (x) => parts.push(x));
    req.on("end", async () => {
      const body = Buffer.concat(parts);
      bodies[req.url] = body;
      const headers = {};
      for (const name of ["content-type", "accept", "authorization"]) {
        if (req.headers[name]) {
          headers[name] = req.headers[name];
        }
      }
      const forwarded = await fetch(serverUrl + req.url, { method: req.method, headers, body: body.length ? body : undefined });
      res.writeHead(forwarded.status, { "Content-Type": forwarded.headers.get("content-type") || "application/msgpack" });
      res.end(Buffer.from(await forwarded.arrayBuffer()));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function checkLoginSlowdown() {
  const username = `slow${Date.now()}`;
  const password = "a password for the slowdown test";
  await (await Etebase.Account.signup({ username, email: `${username}@example.com` }, password, serverUrl)).logout();

  // A login with a wrong password, sent again and again (it's valid as long as its challenge, a minute)
  const bodies = {};
  const proxy = await startRecordingProxy(bodies);
  try {
    await rejects("log in with a wrong password", Etebase.UnauthorizedError,
      Etebase.Account.login(username, "not the password", `http://127.0.0.1:${proxy.address().port}/`));
  } finally {
    proxy.close();
  }
  const wrongLogin = bodies["/api/v1/authentication/login/"];
  const tryAgain = async () => (await fetch(`${serverUrl}/api/v1/authentication/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/msgpack", Accept: "application/msgpack" },
    body: wrongLogin,
  })).status;

  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push(await tryAgain());
  }
  check("five wrong passwords in a row are just refused", statuses.every((x) => x === 401));
  check("after five the next try has to wait", (await tryAgain()) === 429);
  await sleep(1100);
  const etebase = await Etebase.Account.login(username, password, serverUrl);
  check("after waiting the right password works", etebase.user.username === username);
  check("the right password starts the count again", (await tryAgain()) === 401);
  await etebase.logout();
}

async function internal(path, options = {}, secret = internalSecret) {
  const res = await fetch(`${serverUrl}/internal/v1${path}`, {
    ...options,
    headers: { Authorization: `Internal ${secret}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Stands in for the account service: gets the client's signup request and creates the user through the
// internal API, with the email address it verified
function startSignupProxy(expectedEmail, signupBodies) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (x) => parts.push(x));
    req.on("end", async () => {
      const body = Buffer.concat(parts).toString("base64url");
      signupBodies.push(body);
      const created = await internal("/signup/", {
        method: "POST",
        body: JSON.stringify({ signup: body, expected_email: expectedEmail }),
      });
      res.writeHead(created.status, { "Content-Type": "application/msgpack" });
      res.end(created.status === 201 ? Buffer.from(created.body.login, "base64url") : undefined);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function checkInternalApi(takenEmail) {
  if (!internalSecret) {
    const res = await fetch(`${serverUrl}/internal/v1/whoami/`, { method: "POST" });
    check("the internal API doesn't exist without a secret", res.status === 404);
    return;
  }

  check("the internal API refuses a wrong secret",
    (await internal("/username-available/?username=x", {}, "not the secret".padEnd(40, "x"))).status === 401);

  const username = `Internal${Date.now()}`;
  const email = `${username.toLowerCase()}@example.com`;
  const password = "a password for the internal API test";
  check("a free username is available",
    (await internal(`/username-available/?username=${username}`)).body.available === true);
  const withAt = (await internal("/username-available/?username=a%40b")).body;
  check("a username with @ is invalid", (withAt.available === false) && (withAt.reason === "invalid"));

  const signupBodies = [];
  const proxy = await startSignupProxy(email, signupBodies);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}/`;
  try {
    const signedUp = await Etebase.Account.signup({ username, email }, password, proxyUrl);
    check("sign up through the internal API", signedUp.user.username === username.toLowerCase());
    await rejects("the same signup again is refused", undefined,
      Etebase.Account.signup({ username, email }, password, proxyUrl));
  } finally {
    proxy.close();
  }
  const replay = await internal("/signup/", { method: "POST", body: JSON.stringify({ signup: signupBodies[0], expected_email: email }) });
  check("an existing user can't sign up again", (replay.status === 409) && (replay.body.code === "user_exists"));
  const otherEmail = await internal("/signup/", {
    method: "POST", body: JSON.stringify({ signup: signupBodies[0], expected_email: "other@example.com" }),
  });
  check("a signup for another email address is refused",
    (otherEmail.status === 422) && (otherEmail.body.code === "email_mismatch"));
  const garbage = await internal("/signup/", { method: "POST", body: JSON.stringify({ signup: "AAAA", expected_email: email }) });
  check("an unreadable signup is refused", (garbage.status === 400) && (garbage.body.code === "bad_signup"));

  const taken = (await internal(`/username-available/?username=${username.toUpperCase()}`)).body;
  check("a taken username is not available, in any casing", (taken.available === false) && (taken.reason === "taken"));

  // The account created through the internal API works like any other
  const etebase = await Etebase.Account.login(username, password, serverUrl);
  check("log in to the account created through the internal API", etebase.user.email === email);
  const me = await internal("/whoami/", { method: "POST", body: JSON.stringify({ token: etebase.authToken }) });
  check("whoami tells whose token it is", (me.status === 200) && (me.body.username === username.toLowerCase()));
  const byName = await internal(`/users/by-username/${username}/`);
  check("find a user by username", (byName.status === 200) && (byName.body.user_id === me.body.user_id));
  check("an unknown user is not found", (await internal("/users/by-username/nobody-like-this/")).status === 404);

  // Usage and storage limits
  const userId = me.body.user_id;
  const usage = async () => (await internal(`/users/${userId}/usage/`)).body;
  const setLimits = async (limits) => (await internal(`/users/${userId}/limits/`, { method: "PUT", body: JSON.stringify(limits) })).status;
  let used = await usage();
  check("a new account uses nothing and has no limit",
    (used.bytes_used === 0) && (used.collections === 0) && (used.items === 0) && (used.bytes_limit === null));
  check("a negative limit is refused", (await setLimits({ bytes_limit: -1 })) === 422);
  check("set a storage limit", (await setLimits({ bytes_limit: 100 * 1024 })) === 204);

  const quotaColMgr = etebase.getCollectionManager();
  const quotaCol = await quotaColMgr.create(colType, { name: "Quota" }, "");
  await quotaColMgr.upload(quotaCol);
  const quotaItemMgr = quotaColMgr.getItemManager(quotaCol);
  // Random, so the content can't be compressed or shared with other chunks
  const random = (size) => new Uint8Array(require("crypto").randomBytes(size));
  const small = await quotaItemMgr.create({ name: "Small" }, random(20 * 1024));
  await quotaItemMgr.batch([small]);
  used = await usage();
  check("the usage counts the stored data, collections and items",
    (used.bytes_used > 20 * 1024) && (used.collections === 1) && (used.items === 1) && (used.collections_shared === 0));
  check("the usage shows the limit", used.bytes_limit === 100 * 1024);

  const big = await quotaItemMgr.create({ name: "Big" }, random(200 * 1024));
  await rejects("a change over the storage limit is refused", undefined, quotaItemMgr.batch([big]));
  check("a refused change stores nothing", (await usage()).bytes_used === used.bytes_used);

  // A full account can still delete, but not add more
  check("set the limit to what is used", (await setLimits({ bytes_limit: used.bytes_used })) === 204);
  const more = await quotaItemMgr.create({ name: "More" }, random(20 * 1024));
  await rejects("a full account can't add data", undefined, quotaItemMgr.batch([more]));
  small.delete();
  await quotaItemMgr.batch([small]);
  check("a full account can delete", (await usage()).items === 0);

  check("make the account read-only", (await setLimits({ read_only: true })) === 204);
  await rejects("a read-only account can't create a collection", undefined,
    quotaColMgr.upload(await quotaColMgr.create(colType, { name: "Read-only" }, "")));
  check("remove the limits", (await setLimits({})) === 204);
  await quotaItemMgr.batch([await quotaItemMgr.create({ name: "Without limits" }, random(200 * 1024))]);
  check("without limits a big change is accepted", (await usage()).bytes_limit === null);

  // The apps' "Account Dashboard" button
  if (dashboardSecret) {
    const [link, ticket] = (await etebase.getDashboardUrl()).split("#");
    const [payload, signature] = ticket.split(".");
    const expected = require("crypto").createHmac("sha256", dashboardSecret)
      .update(Buffer.from(payload, "base64url")).digest("base64url");
    const data = JSON.parse(Buffer.from(payload, "base64url"));
    const validFor = data.exp - (Date.now() / 1000);
    check("the dashboard link goes to the dashboard", link === process.env.DASHBOARD_URL);
    check("the dashboard ticket is signed", signature === expected);
    check("the dashboard ticket is for the user, for a minute",
      (data.uid === userId) && (validFor > 50) && (validFor <= 60) && (data.nonce.length > 0));
  } else {
    await rejects("without a dashboard there is no dashboard link", undefined, etebase.getDashboardUrl());
  }

  // Changing the email address
  const setEmail = async (address) => internal(`/users/${userId}/email/`, { method: "PUT", body: JSON.stringify({ email: address }) });
  check("an invalid email address is refused", (await setEmail("not an address")).body.code === "invalid_email");
  check("another user's email address is refused", (await setEmail(takenEmail.toUpperCase())).body.code === "email_taken");
  check("the same email address again is fine", (await setEmail(email)).status === 204);
  const newEmail = `new-${email}`;
  check("change the email address", (await setEmail(newEmail)).status === 204);
  const byEmail = await Etebase.Account.login(newEmail, password, serverUrl);
  check("log in with the new email address", byEmail.user.email === newEmail);

  // Account.logout() doesn't wait for the server, so log out with a request of our own
  const token = etebase.authToken;
  await fetch(`${serverUrl}/api/v1/authentication/logout/`, { method: "POST", headers: { Authorization: `Token ${token}` } });
  const loggedOut = await internal("/whoami/", { method: "POST", body: JSON.stringify({ token }) });
  check("whoami refuses a token after logging out", (loggedOut.status === 401) && (loggedOut.body.code === "invalid_token"));
  check("whoami refuses a made-up token",
    (await internal("/whoami/", { method: "POST", body: JSON.stringify({ token: "x".repeat(40) }) })).status === 401);

  // Suspending and deleting
  const again = await Etebase.Account.login(username, password, serverUrl);
  const againColMgr = again.getCollectionManager();
  check("suspend a user", (await internal(`/users/${userId}/suspend/`, { method: "POST" })).status === 204);
  await rejects("a suspended user can't sync", undefined, againColMgr.list(colType));
  check("unsuspend a user", (await internal(`/users/${userId}/unsuspend/`, { method: "POST" })).status === 204);
  check("an unsuspended user can sync again", (await againColMgr.list(colType)).data.length > 0);
  check("delete a user", (await internal(`/users/${userId}/`, { method: "DELETE" })).status === 204);
  await rejects("a deleted user can't sync", undefined, againColMgr.list(colType));
  await rejects("a deleted user can't log in", undefined, Etebase.Account.login(username, password, serverUrl));
  check("a deleted user is gone",
    ((await internal(`/users/by-username/${username}/`)).status === 404) && ((await internal(`/users/${userId}/usage/`)).status === 404));
  check("deleting a deleted user does nothing", (await internal(`/users/${userId}/`, { method: "DELETE" })).status === 204);
}
