// A maker's accounts, as the section that leads its page in Settings: Claude Code's on the Claude Code page
// (settings/claude-page.tsx), Codex's on the Codex page (settings/codex-page.tsx). The logins Canopy found and the accounts added in it (a second
// Claude sign-in, a pasted API key), and which one new chats use. One account per maker at a time: the one in use
// has a check at the end of its row, and "Use" on another row chooses that one, for new chats.
//
// The section is Settings' own (settings/kit.tsx `Section`), and a row has the measure of its `Row`: the same
// padding, the same two lines of words, between the same hairlines. What a row adds is its lead, the maker's mark,
// as on the accounts in macOS's own settings. What a row is built from, what you act on in it, and "Add account",
// are in account-actions.tsx. A login that is gone gets its maker's own sign-in on its row (account-prompt.tsx):
// Claude Code's in a terminal in the window, Codex's in the browser. Codex has one login for this Mac: it can be
// signed in to when it has none that works (the "Not signed in" row below), and signed out of from the row's menu
// (codex-signin.tsx). Beside it, an OpenAI API key pasted into Canopy is an account of its own: the same row, the
// same "Use", and Codex's login is left as it is.
import { useContext, useEffect, useState } from 'react';
import { LogInIcon } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { accountLine, needsAttention, refreshAccounts, useAccounts } from '@/lib/accounts';
import type { Account, AccountsState, Engine, EnvInfo } from '@/lib/api';
import { signInToCodex, useCodexLogin } from '@/lib/codex-login';
import { SIGN_IN, showSignedOut } from '@/lib/codex-login-rules';
import { openSignIn } from '@/lib/signin';
import { cn } from '@/lib/utils';
import { AddAccount, RenameField, ROW, ROW_BTN, RowActions, RowMark, useAccountRow } from './account-actions';
import { RowSignIn } from './account-prompt';
import { PageFrame, Section } from './settings/kit';

/** The section. Its card holds one list, named for the tool so a screen reader says whose accounts these are. */
function Accounts({ tool, id, footer, children }: { tool: string; id?: string; footer?: string; children: React.ReactNode }) {
  const embedded = !!useContext(PageFrame).embed; // on Settings → Accounts the tool's own heading stands above it
  return (
    <Section id={id} title={embedded ? undefined : 'Accounts'} footer={footer}>
      <div role="list" aria-label={`${tool} accounts`} className="divide-y divide-hairline">{children}</div>
    </Section>
  );
}
// A row's name, and under it one quieter line.
const name = 'flex text-ui font-medium';
// The second line of a row. What is wrong, when something is, stands behind the one amber dot.
function Detail({ text, attention }: { text: string; attention?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-small', attention ? 'text-foreground/85' : 'text-muted-foreground')}>
      {attention && <span role="img" aria-label="Needs attention" className="size-1.5 shrink-0 rounded-full bg-warn" />}
      <span className="truncate" title={text}>{text}</span>
    </div>
  );
}

function AccountRow({ a, inUse }: { a: Account; inUse: boolean }) {
  const broken = needsAttention(a);
  const row = useAccountRow(a, inUse);
  const says = accountLine(a);
  return (
    <div role="listitem" className={ROW}>
      <RowMark engine={a.engine} />
      <div className="min-w-0 flex-1">
        <div className={name}>{row.renaming ? <RenameField row={row} /> : <span className="truncate">{a.label}</span>}</div>
        <Detail text={says} attention={broken} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* A sign-in that is gone: the one thing to do about it (its maker's own sign-in), before where the row
            stands and its menu. */}
        {broken && <RowSignIn account={a} className={ROW_BTN} />}
        <RowActions row={row} />
      </div>
    </div>
  );
}

/** A row that is not an account: what stands in for one (nobody signed in, nothing found), with its one button. */
function Standing({ engine, title, detail, attention, children }: { engine: Engine; title: string; detail: string; attention?: boolean; children?: React.ReactNode }) {
  return (
    <div role="listitem" className={ROW}>
      <RowMark engine={engine} />
      <div className="min-w-0 flex-1">
        <div className={name}>{title}</div>
        <Detail text={detail} attention={attention} />
      </div>
      {children}
    </div>
  );
}
const Checking = () => (
  <div role="listitem" className={cn(ROW, 'text-ui text-muted-foreground')}>
    <span className="flex size-8 shrink-0 items-center justify-center"><Spinner className="size-4" /></span>Checking…
  </div>
);

// A maker with no login to show: still being asked, or the tool did not answer.
function NothingYet({ checking, engine, tool }: { checking: boolean; engine: Engine; tool: string }) {
  const [asking, setAsking] = useState(false);
  const again = async () => { setAsking(true); try { await refreshAccounts(true); } finally { setAsking(false); } };
  if (checking || asking) return <Checking />;
  return (
    <Standing engine={engine} title="No login found" detail={`${tool} didn’t say who is signed in`}>
      <button type="button" onClick={again} className={ROW_BTN}>Check Again</button>
    </Standing>
  );
}

const rowsFor = (s: AccountsState | null, engine: Engine) => {
  const inUse = s?.inUse?.[engine] ?? null;
  // The logins the tool holds itself, then the accounts added in Canopy, each as main lists them. Whichever is in
  // use: choosing another never moves a row from under the pointer. (The tool's own lead, so a login that shows up
  // later, Codex signed in to after a key was added, takes the place the "Not signed in" row had.)
  const all = (s?.list ?? []).filter((a) => a.engine === engine);
  const list = [...all.filter((a) => a.found), ...all.filter((a) => !a.found)];
  return { list, inUse };
};

/**
 * Claude Code's accounts. `auth`: what is known of Claude Code's own sign-in (the launch's answer, kept in line with
 * the accounts list by App). It only matters while nothing is listed: a login that never worked on this Mac is not
 * in the list, so "signed out" then has no row of its own to say it on. `id`: the section's, for a link to it from
 * the top of the page.
 */
export function ClaudeAccounts({ auth, id }: { auth: EnvInfo['auth']; id?: string }) {
  const accounts = useAccounts();
  // Opening the page asks the tools again, quietly: what is already known stays on screen meanwhile.
  useEffect(() => { refreshAccounts(); }, []);
  const { list, inUse } = rowsFor(accounts, 'claude');
  // Only one case needs words under the list: nothing chosen, and the environment supplies a login on top of Claude
  // Code's own sign-in, which wins. Otherwise the rows say it all.
  const using = list.find((a) => a.id === inUse);
  const hint = !accounts?.active.claude && list.length > 1 && using?.kind === 'external'
    ? 'Claude Code uses a login from your environment before its own sign-in, here as in the terminal.'
    : undefined;
  const checking = !accounts || accounts.checking;
  return (
    <Accounts tool="Claude Code" id={id} footer={hint}>
      {list.map((a) => <AccountRow key={a.id} a={a} inUse={a.id === inUse} />)}
      {!list.length && (!checking && auth?.loggedIn === false ? (
        // Claude Code says nobody is signed in: its own sign-in, for the login it keeps itself.
        <Standing engine="claude" title="Not signed in" detail="Chats can’t start until Claude Code is signed in" attention>
          <button type="button" onClick={() => { openSignIn('claude'); }} className={ROW_BTN}><LogInIcon className="size-3.5" />Sign in…</button>
        </Standing>
      ) : <NothingYet checking={checking} engine="claude" tool="Claude Code" />)}
      {/* Offered once the first read is in: main says what there is before anything is added to it. */}
      {accounts && <AddAccount engine="claude" />}
    </Accounts>
  );
}

/**
 * Codex's accounts: its own login (or the row saying it has none, with its sign-in), then the OpenAI keys pasted
 * into Canopy. `installed`: Codex is on this Mac, as its page knows it. Without Codex there is nothing to run a key
 * on either, so there is no section then unless something is already listed (a key added before Codex went: it can
 * still be removed here). `id`: the section's, for a link to it from the top of the page.
 */
export function CodexAccounts({ installed, id }: { installed: boolean; id?: string }) {
  const accounts = useAccounts();
  const login = useCodexLogin();
  useEffect(() => { refreshAccounts(); }, []);
  const { list, inUse } = rowsFor(accounts, 'codex');
  if (!list.length && !installed) return null;
  // Codex is on this Mac with nobody signed in: no login of its own to list, but something to offer.
  const signedOut = showSignedOut(list.filter((a) => a.found).length, login);
  // Main has not said yet who is signed in: the section keeps its place meanwhile.
  const waiting = !list.length && !signedOut && (!accounts || accounts.checking);
  const canAdd = !!accounts && login?.installed === true;
  if (!list.length && !waiting && !signedOut && !canAdd) return null; // nothing to list and nothing to offer
  return (
    <Accounts tool="Codex" id={id}>
      {waiting && <Checking />}
      {signedOut && (
        <Standing engine="codex" title="Not signed in" detail="Codex is on this Mac, with nobody signed in">
          <button type="button" onClick={() => { signInToCodex(); }} disabled={!login?.canSignIn} className={ROW_BTN}><LogInIcon className="size-3.5" />{SIGN_IN}</button>
        </Standing>
      )}
      {list.map((a) => <AccountRow key={a.id} a={a} inUse={a.id === inUse} />)}
      {canAdd && <AddAccount engine="codex" />}
    </Accounts>
  );
}
