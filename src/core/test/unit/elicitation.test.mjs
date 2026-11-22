// A question an MCP server puts to the user (elicitation.mjs): a schema as the card's fields, what was typed as the
// values the server asked for, and the answer in MCP's words. Pure: no session, no process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerOf, contentOf, describe, fieldsOf, serverWords, webLink } from '../../elicitation.mjs';

const SCHEMA = {
  type: 'object', required: ['title', 'team'],
  properties: {
    title: { type: 'string', title: 'Issue title', description: 'One line.', minLength: 1, maxLength: 80 },
    contactEmail: { type: 'string', format: 'email', default: 'a@b.co' },
    points: { type: 'integer', minimum: 0, maximum: 13, default: 3 },
    budget: { type: 'number' },
    urgent: { type: 'boolean', title: 'Urgent', default: true },
    team: { type: 'string', oneOf: [{ const: 'eng', title: 'Engineering' }, { const: 'ops', title: 'Operations' }], default: 'ops' },
    size: { type: 'string', enum: ['s', 'm', 'l'], enumNames: ['Small', 'Medium'] },
    labels: { type: 'array', items: { anyOf: [{ const: 'bug', title: 'Bug' }, { const: 'ui', title: 'UI' }] }, default: ['ui', 'gone'] },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    notes: { type: 'array', items: { type: 'string' } },
    odd: 'not a property',
  },
};

test('a form schema becomes fields: text, number, switch, one choice, several choices', () => {
  const f = fieldsOf(SCHEMA);
  assert.deepEqual(f.map((x) => [x.key, x.kind]), [['title', 'text'], ['contactEmail', 'text'], ['points', 'number'], ['budget', 'number'], ['urgent', 'boolean'], ['team', 'choice'], ['size', 'choice'], ['labels', 'choices'], ['tags', 'choices']]);
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.deepEqual(by.title, { key: 'title', label: 'Issue title', help: 'One line.', required: true, kind: 'text', default: null, format: null, minLength: 1, maxLength: 80 });
  assert.deepEqual([by.contactEmail.label, by.contactEmail.format, by.contactEmail.default, by.contactEmail.required], ['Contact email', 'email', 'a@b.co', false]);
  assert.deepEqual([by.points.integer, by.points.min, by.points.max, by.points.default], [true, 0, 13, 3]);
  assert.deepEqual([by.budget.integer, by.budget.default], [false, null]);
  assert.equal(by.urgent.default, true);
  assert.deepEqual([by.team.options, by.team.default, by.team.required], [[{ value: 'eng', label: 'Engineering' }, { value: 'ops', label: 'Operations' }], 'ops', true]);
  assert.deepEqual(by.size.options, [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'l' }]);
  assert.deepEqual([by.labels.options.map((o) => o.value), by.labels.default], [['bug', 'ui'], ['ui']]);
  assert.deepEqual(by.tags.default, []);
});

test('a schema that is not a form has no fields, and nothing throws', () => {
  for (const s of [null, undefined, 'x', 7, [], {}, { type: 'object' }, { properties: [] }, { properties: { a: null } }]) assert.deepEqual(fieldsOf(s), []);
  const hostile = { properties: { get a() { throw new Error('boom'); } } };
  assert.doesNotThrow(() => fieldsOf(hostile));
  const many = { properties: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { type: 'string' }])) };
  assert.equal(fieldsOf(many).length, 40);
});

test('what was typed goes back as the values the server asked for', () => {
  const f = fieldsOf(SCHEMA);
  assert.deepEqual(contentOf(f, { title: 'Fix', contactEmail: '', points: '8', budget: 12.5, urgent: false, team: 'eng', size: 'xl', labels: ['bug', 'nope'], tags: 'a', extra: 1 }),
    { title: 'Fix', points: 8, budget: 12.5, urgent: false, team: 'eng', labels: ['bug'] });
  assert.deepEqual(contentOf(f, { points: '2.5', budget: 'lots' }), {}, 'a number that is not one is left out');
  assert.deepEqual(contentOf(f, null), {});
  assert.deepEqual(contentOf(null, { a: 1 }), {});
});

test('the card says who is asking and which of the three kinds it is', () => {
  const form = describe({ serverName: 'linear', message: 'New issue', mode: 'form', requestedSchema: SCHEMA });
  assert.deepEqual([form.ask, form.title, form.mode, form.url, form.fields.length], ['form', 'Linear needs a few details', 'form', null, 9]);
  const yes = describe({ serverName: 'my_docs-server', message: 'Publish?', requestedSchema: { type: 'object', properties: {} } });
  assert.deepEqual([yes.ask, yes.title, yes.fields], ['confirm', 'My docs server needs your OK', []]);
  const link = describe({ serverName: 'github', message: 'Sign in', mode: 'url', url: 'https://github.com/login', elicitationId: 'e1', requestedSchema: SCHEMA });
  assert.deepEqual([link.ask, link.title, link.url, link.elicitationId, link.fields], ['link', 'Github wants you to open a link', 'https://github.com/login', 'e1', []]);
  assert.equal(describe({ mode: 'url', url: 'javascript:alert(1)' }).url, null, 'only a web page is opened');
  assert.equal(describe({ serverName: 'x', title: 'Pay the invoice' }).title, 'Pay the invoice', 'a title the server gave wins');
  assert.equal(describe(null).title, 'A connected tool needs your OK');
  assert.equal(serverWords(''), 'A connected tool');
  assert.deepEqual([webLink('http://a.test/x'), webLink('file:///etc/passwd'), webLink('nope'), webLink(null)], ['http://a.test/x', null, null, null]);
});

test('answers are accept with the values, decline, or cancel', () => {
  const f = fieldsOf(SCHEMA);
  assert.deepEqual(answerOf(f, { action: 'elicit-accept', content: { title: 'x', points: '1' } }), { action: 'accept', content: { title: 'x', points: 1 } });
  assert.deepEqual(answerOf([], { action: 'elicit-accept', content: { a: 1 } }), { action: 'accept', content: {} });
  assert.deepEqual(answerOf(f, { action: 'elicit-decline' }), { action: 'decline' });
  for (const a of [{ action: 'elicit-cancel' }, { action: 'deny' }, {}, null, 'x']) assert.deepEqual(answerOf(f, a), { action: 'cancel' });
});
