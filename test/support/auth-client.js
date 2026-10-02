const { randomUUID } = require('node:crypto');

async function register(origin, name = 'Test User') {
  const email = `${randomUUID()}@example.com`;
  const response = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'testing-password-123' })
  });
  if (response.status !== 201) throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
  return { cookie: response.headers.get('set-cookie').split(';')[0], email, user: (await response.json()).user };
}

module.exports = { register };
