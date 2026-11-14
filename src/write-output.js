// Publish only a fully validated candidate. The staging directory is a sibling of
// the destination, so rename stays on the same filesystem. Never unlink the old
// destination first: a failed write/rename must leave it intact.
import fs from 'node:fs';
import path from 'node:path';

export function writeOutputAtomic(destination, content, io = fs) {
  const target = path.resolve(destination);
  const staging = io.mkdtempSync(path.join(path.dirname(target), '.legible-'));
  const candidate = path.join(staging, 'candidate.html');
  try {
    io.writeFileSync(candidate, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    io.renameSync(candidate, target);
  } finally {
    io.rmSync(staging, { recursive: true, force: true });
  }
}
