// A chat dragged out of the sidebar, onto the chat area (opens Multi mode with it beside the chat you're in) or onto a
// Multi mode pane (it goes in that pane). The drag carries the chat as its own data type, so nothing else that can be
// dropped (files, text) is mistaken for one.
export const CHAT_DRAG = 'application/x-canopy-chat';
export type DraggedChat = { dir: string; id: string };

export const setDraggedChat = (dt: DataTransfer, chat: DraggedChat) => dt.setData(CHAT_DRAG, JSON.stringify(chat));
/** Whether a chat is being dragged (its data can only be read on drop; its type can be seen all along). */
export const carriesChat = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes(CHAT_DRAG);
export function draggedChat(dt: DataTransfer | null): DraggedChat | null {
  try {
    const v = JSON.parse(dt?.getData(CHAT_DRAG) || 'null');
    return v && typeof v.dir === 'string' && typeof v.id === 'string' ? { dir: v.dir, id: v.id } : null;
  } catch { return null; }
}
