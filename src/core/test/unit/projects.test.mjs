// The sidebar's projects (renderer/src/lib/projects.ts): which folders are listed, in which order, with which chats.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupProjects } from '../../../../renderer/src/lib/projects.ts';

const chat = (id, cwd, updated) => ({ id, title: id, updated, cwd });
const CHATS = '/Users/sam/Library/Application Support/Canopy/chats';

test('projects are the saved folders, in the order they were saved, each with its chats newest first', () => {
  const sessions = [chat('a1', '/work/app', 10), chat('s1', '/work/site', 50), chat('a2', '/work/app', 30), chat('loose', CHATS, 99), chat('x', '/work/elsewhere', 70), chat('none', null, 5)];
  const projects = groupProjects(sessions, ['/work/site', '/work/app', '/work/empty'], null, CHATS);
  assert.deepEqual(projects.map((p) => [p.dir, p.sessions.map((s) => s.id), p.updated]), [
    ['/work/site', ['s1'], 50],
    ['/work/app', ['a2', 'a1'], 30],
    ['/work/empty', [], 0],
  ], 'a chat in a folder that was never opened here, and one with no project, are in none of them');
});

test('the folder of the chat on screen is listed even when it is not saved, after the saved ones; the chats folder never is', () => {
  const sessions = [chat('n1', '/work/new', 5), chat('a1', '/work/app', 10)];
  assert.deepEqual(groupProjects(sessions, ['/work/app'], '/work/new', CHATS).map((p) => [p.dir, p.sessions.length]), [['/work/app', 1], ['/work/new', 1]]);
  assert.deepEqual(groupProjects(sessions, ['/work/app'], '/work/app', CHATS).map((p) => p.dir), ['/work/app'], 'already saved: listed once');
  assert.deepEqual(groupProjects([chat('l', CHATS, 1)], [CHATS, '/work/app'], CHATS, CHATS).map((p) => p.dir), ['/work/app']);
  assert.deepEqual(groupProjects([], [], null, null), []);
});

test('opening a project never reshuffles the list: a newer chat does not move its folder up', () => {
  const before = groupProjects([chat('a', '/work/app', 1), chat('s', '/work/site', 2)], ['/work/app', '/work/site'], '/work/app', CHATS);
  const after = groupProjects([chat('a', '/work/app', 1), chat('s', '/work/site', 2), chat('s2', '/work/site', 900)], ['/work/app', '/work/site'], '/work/site', CHATS);
  assert.deepEqual(before.map((p) => p.dir), after.map((p) => p.dir));
});
