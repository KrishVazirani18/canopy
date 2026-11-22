// The confirm a link in a reply opens: one for a page on this Mac, one for a website.
import { LinkConfirm } from '@/components/canopy/link-confirm';
import { useState } from 'react';

export const title = 'Link confirm';

export default function LinkConfirmMock() {
  const [url, setUrl] = useState('http://localhost:8765/?cycle');
  return (
    <div className="flex h-full items-start gap-2 p-6">
      {['http://localhost:8765/?cycle', 'https://github.com/example/app/releases/latest'].map((u) => (
        <button key={u} className="rounded-md border border-hairline px-2 py-1 text-small" onClick={() => setUrl(u)}>{new URL(u).host}</button>
      ))}
      <LinkConfirm isOpen url={url} onClose={() => {}} onConfirm={() => {}} />
    </div>
  );
}
