// "Request Updates" (renderer/src/lib/request-updates.ts): a chat knows the question by its exact text, also when it is
// reopened from history. So the text is held here: a change to it has to keep the old wording recognised.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { UPDATE_PROMPT, isUpdateRequest } from '../../../../renderer/src/lib/request-updates.ts';

test('the question is known as it is sent, with or without space around it', () => {
  assert.equal(isUpdateRequest(UPDATE_PROMPT), true);
  assert.equal(isUpdateRequest(`\n  ${UPDATE_PROMPT}  \n`), true);
});

test('the two earlier wordings, already in saved chats, are still known', () => {
  assert.equal(isUpdateRequest('Give me a quick update on the agents and workflows that are still running'), true);
  assert.equal(isUpdateRequest('Give me a quick update on the agents and workflows that are still running. One line each.'), true);
  assert.equal(isUpdateRequest('Where do the running agents and workflows stand? Show it as one widget, not a table. A row per agent.'), true);
});

test('a message you typed is not one, even when it starts the same way', () => {
  for (const typed of ['', 'Where do the running agents and workflows stand?', 'How is it going?', `${UPDATE_PROMPT} And one more thing.`, `Please: ${UPDATE_PROMPT}`]) {
    assert.equal(isUpdateRequest(typed), false, typed.slice(0, 60));
  }
});

test('the question’s text has not changed', () => {
  assert.equal(
    createHash('sha256').update(UPDATE_PROMPT).digest('hex'),
    '7a3b4564c7dcfcdd83e28b1a06806225c21060eb26ecb13f36943e418c166654',
    'Changed the prompt? Every chat that already holds the old text would show it as a long message somebody typed. Add the old text to EARLIER in request-updates.ts, then update this hash.',
  );
});
