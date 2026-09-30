const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

test('reservation API returns client errors for malformed bodies', async () => {
  await new Promise(resolve => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}/api/reservations`;
  try {
    for (const [body, expected] of [['null', 400], ['[]', 400], ['{', 400], [JSON.stringify({ matchId: '1', seatId: 1, name: 'A', email: 'a@b.com' }), 400], ['x'.repeat(10_001), 413]]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, expected, body.slice(0, 30));
      assert.ok((await response.json()).error);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
