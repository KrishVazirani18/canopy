// redact.mjs: secrets must not reach the UI through stderr tails or error messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const R = await core('redact.mjs');
const missing = R.__missing ? `redact.mjs: ${R.__missing}` : (typeof R.makeRedactor === 'function' ? false : 'redact.mjs does not export makeRedactor');

test('values of secret-looking environment variables are removed', { skip: missing }, () => {
  const redact = R.makeRedactor({ MY_API_KEY: 'abcd1234efgh', GITHUB_TOKEN: 'tok_0123456789', DB_PASSWORD: 'hunter2hunter2', AWS_SECRET: 's3cr3t-value!', HOME: '/Users/someone' });
  const out = redact('failed: key=abcd1234efgh token tok_0123456789 pw hunter2hunter2 aws s3cr3t-value! in /Users/someone/project');
  for (const secret of ['abcd1234efgh', 'tok_0123456789', 'hunter2hunter2', 's3cr3t-value!']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('[redacted]'));
  assert.ok(out.includes('/Users/someone/project'), 'ordinary values stay readable');
});

test('short values and location variables are left alone', { skip: missing }, () => {
  const redact = R.makeRedactor({ API_KEY: 'short', SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners', TOKEN_FILE: '/Users/someone/.token-file', AUTH_DIR: '/Users/someone/authdir', KEY_PATH: '/Users/someone/key.pem' });
  const text = 'a short word, /private/tmp/com.apple.launchd.abc/Listeners, /Users/someone/.token-file, /Users/someone/authdir, /Users/someone/key.pem';
  assert.equal(redact(text), text);
});

test('the longest secret wins when one contains another', { skip: missing }, () => {
  const redact = R.makeRedactor({ TOKEN_A: 'abcdefgh', TOKEN_B: 'abcdefghijklmnop' });
  const out = redact('value abcdefghijklmnop end');
  assert.ok(!out.includes('ijklmnop'), `half a secret survived: ${out}`);
  assert.equal(out, 'value [redacted] end');
});

test('secrets with regex characters are matched literally', { skip: missing }, () => {
  const secret = 'a.b*c+d?e(f)[g]{h}|i^j$k\\l';
  const redact = R.makeRedactor({ WEIRD_SECRET: secret });
  assert.equal(redact(`x ${secret} y`), 'x [redacted] y');
  assert.equal(redact('x aXb*c+d?e(f)[g]{h}|i^j$k\\l y'), 'x aXb*c+d?e(f)[g]{h}|i^j$k\\l y');
});

test('known token shapes are removed without any environment', { skip: missing }, () => {
  const redact = R.makeRedactor({});
  const out = redact('key sk-ant-api03-AbCdEf0123456789_xyz and header Authorization: Bearer eyJhbGciOi.payload.sig-123 and url https://alice:p4ssw0rd@example.com/repo.git');
  assert.ok(!out.includes('AbCdEf0123456789'), out);
  assert.ok(!out.includes('eyJhbGciOi'), out);
  assert.ok(!out.includes('p4ssw0rd'), out);
  assert.ok(out.includes('example.com/repo.git'), 'the host and path of a URL stay');
});

test('ordinary text passes through unchanged', { skip: missing }, () => {
  const redact = R.makeRedactor({ MY_API_KEY: 'abcd1234efgh' });
  const text = "error: unknown option '--thinking-display'\n    at /usr/local/lib/node_modules/x.js:10:3\nNo conversation found with session ID: 9d0f6c1e-7b1a-4c53-9a54-0e2f8d1b2c3d";
  assert.equal(redact(text), text);
});

test('the redactor accepts anything and never throws', { skip: missing }, () => {
  for (const env of [undefined, null, {}, { A_TOKEN: undefined, B_KEY: 42 }, 'nonsense']) {
    let redact;
    assert.doesNotThrow(() => { redact = R.makeRedactor(env); });
    for (const input of [undefined, null, '', 0, {}, new Error('with sk-ant-api03-AbCdEf0123456789')]) {
      let out;
      assert.doesNotThrow(() => { out = redact(input); });
      assert.equal(typeof out, 'string');
      assert.ok(!out.includes('AbCdEf0123456789'));
    }
  }
});

test('a redactor is bound to the environment it was made from', { skip: missing }, () => {
  const env = { SERVICE_TOKEN: 'first-token-value' };
  const redact = R.makeRedactor(env);
  env.SERVICE_TOKEN = 'second-token-value';
  assert.ok(!redact('first-token-value').includes('first-token-value'));
});
