// The daily summary's scan, in a process of its own: reading a month of transcripts is seconds of work on gigabytes
// of files, and none of it may be felt in Canopy. A thread inside Canopy's process was not far enough away (on a
// busy Mac the window still froze while it read), so summary.mjs starts this file as a separate, low-priority
// process, hands it one job and waits for one answer.
//
// What crosses between the two is kept small on purpose:
//   in    the job: which folders to read, which days, Canopy's chat ids, the cache file
//   out   { ready: true } once this file has loaded, then one of
//         { ok: true, days, stats }    the counts per day, and how the scan went (numbers and flags)
//         { ok: false, code }          it failed: the error's code, never its words (they can name a file)
// It prints nothing, and ends with Canopy: when the channel to Canopy closes, for any reason, it exits.
import { scan } from './summary-scan.mjs';

const CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const codeOf = (err) => [err?.code, err?.name].find((c) => typeof c === 'string' && CODE.test(c)) ?? 'Error';

/** Say one last thing and leave. Leaving waits for the message to be on its way, or for the channel to be gone. */
function answer(message, exitCode) {
  const leave = () => process.exit(exitCode);
  try { process.send(message, leave); } catch { leave(); }
}

if (typeof process.send !== 'function') process.exit(2); // run by hand, not by Canopy: there is nobody to answer

process.on('disconnect', () => process.exit(0));
process.once('message', (job) => {
  scan(job).then(
    (result) => answer({ ok: true, days: result.days, stats: result.stats }, 0),
    (err) => answer({ ok: false, code: codeOf(err) }, 1),
  );
});
// Said once this file and the scan have loaded, so summary.mjs can tell "the process never got going" (it then
// scans in Canopy's own process, in small steps) from "the scan failed" (it reports that).
process.send({ ready: true });
