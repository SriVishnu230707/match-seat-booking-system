const { randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'cricket_session';
const sessionKey = token => `session:${createHash('sha256').update(token).digest('hex')}`;
const publicUser = user => ({ id: user.id, name: user.name, email: user.email });

async function hashPassword(password, salt = randomBytes(32).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString('hex') };
}

async function createUser(db, { name, email, password }) {
  const credentials = await hashPassword(password);
  try {
    const result = db.prepare('INSERT INTO users (name, email, password_salt, password_hash) VALUES (?, ?, ?, ?)')
      .run(name, email, credentials.salt, credentials.hash);
    return publicUser(db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE constraint failed: users.email')) return null;
    throw error;
  }
}

async function verifyUser(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const salt = user?.password_salt || '00000000000000000000000000000000';
  const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, expected) && user ? publicUser(user) : null;
}

function cookieHeader(token, secure = false) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearCookieHeader(secure = false) {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function readToken(req) {
  const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  const token = part?.slice(COOKIE_NAME.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

async function createSession(client, userId) {
  if (!client?.isReady) return null;
  const token = randomBytes(32).toString('base64url');
  try {
    await client.set(sessionKey(token), String(userId), { EX: SESSION_SECONDS });
    return token;
  } catch (error) {
    console.warn(`Session creation failed: ${error.message}`);
    return null;
  }
}

async function currentUser(client, db, req) {
  const token = readToken(req);
  if (!token) return { status: 401 };
  if (!client?.isReady) return { status: 503 };
  try {
    const userId = Number(await client.get(sessionKey(token)));
    if (!Number.isSafeInteger(userId) || userId < 1) return { status: 401 };
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
    return user ? { status: 200, user: publicUser(user), token } : { status: 401 };
  } catch (error) {
    console.warn(`Session lookup failed: ${error.message}`);
    return { status: 503 };
  }
}

async function deleteSession(client, token) {
  if (!client?.isReady) return false;
  try { await client.del(sessionKey(token)); return true; }
  catch (error) { console.warn(`Session deletion failed: ${error.message}`); return false; }
}

module.exports = { createUser, verifyUser, createSession, currentUser, deleteSession, cookieHeader, clearCookieHeader };
