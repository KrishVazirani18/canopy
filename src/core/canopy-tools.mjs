// The tools Canopy gives a chat, whoever's model runs it. One list, in one order.
//
// Each tool is defined in its own file (see tool-registry.mjs for what a definition is). A Claude chat has them on
// in-process servers (session.mjs); a Codex chat has the same ones through the relay (tool-relay.mjs), in this
// order. A new tool is added here once and reaches every engine that takes tools through the relay.
//
// Not here: Code Mode (code-mode.mjs, Claude only; Codex has a code mode of its own that Canopy does not drive).
import { LOOK } from './look.mjs';
import { READ_CHAT } from './read-chat.mjs';
import { FORGET, RECALL, REMEMBER } from './memory-tools.mjs';
import { READ_ME, SHOW_WIDGET } from './widgets.mjs';
import { TASK } from './task-tool.mjs';

/**
 * Every tool, in the order a model is told about them. The order is part of what a chat's cache is keyed on, so a
 * new tool goes at the end.
 */
export const CANOPY_TOOLS = Object.freeze([LOOK, READ_CHAT, SHOW_WIDGET, READ_ME, REMEMBER, RECALL, FORGET, TASK]);

/**
 * The tools one chat has, of those: the ones that can work for it (`ctx` is the chat, as tool-registry.mjs describes
 * it). Decided once, when the chat's process starts, and the same every time that chat is opened on this Mac.
 */
export function toolsFor(ctx, all = CANOPY_TOOLS) {
  return all.filter((t) => { try { return t.available ? t.available(ctx) === true : true; } catch { return false; } });
}
