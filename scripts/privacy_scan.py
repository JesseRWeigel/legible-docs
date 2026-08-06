#!/usr/bin/env python3
"""Scan every tracked file for credentials and personal paths, and prove the scan can see.

Three failure modes this is built around, all of which produce a clean report from a scan that
found nothing because it read nothing:

  1. Before the first commit `git ls-files` is empty, so the scan opens no files and passes.
     A tracked-file count below a floor is therefore a failure, not a clean result.

  2. One NUL byte makes git and grep classify a file as binary, and `grep -I` then skips it
     entirely. This reads bytes in Python and decodes with errors='replace', so a NUL in the
     middle of a file does not blind the scan to the rest of it.

  3. A scan with a broken pattern is silent in exactly the same way as a clean tree. So a
     positive control is planted in the scanned set first, and the run fails if the scanner
     does not find it.

The patterns are assembled from fragments at runtime so this file does not itself contain a
complete credential-shaped string. GitHub push protection scans full history and rejects the
whole push over one synthetic key, and a later fix does not help.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile

HOME_ROOTS = ('home', 'Users')


def build_patterns():
    """Credential shapes, assembled so no complete pattern literal exists on disk."""
    gh = 'gh' + 'p_'
    ghs = 'gh' + 's_'
    sk = 'sk' + '-'
    aws = 'AK' + 'IA'
    pk = 'BEGIN' + ' ' + '(RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
    slack = 'xox' + '[baprs]'
    return [
        # GitHub personal access tokens. Case sensitive: the real format is lower case prefix
        # plus a mixed case body, and a case-insensitive match false-positives on base64.
        (re.compile(gh + r'[A-Za-z0-9]{30,}'), 'GitHub personal access token'),
        (re.compile(ghs + r'[A-Za-z0-9]{30,}'), 'GitHub server token'),
        # OpenAI and OpenRouter style keys.
        (re.compile(sk + r'(or-v1-)?[A-Za-z0-9_-]{32,}'), 'API key with an sk- prefix'),
        # AWS access key ids are uppercase by definition, so this stays case sensitive.
        (re.compile(aws + r'[0-9A-Z]{16}'), 'AWS access key id'),
        (re.compile(slack + r'-[A-Za-z0-9-]{10,}'), 'Slack token'),
        (re.compile(r'-----' + pk), 'private key block'),
        (re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'), 'Google API key'),
        (re.compile(r'(?i)\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*'
                    r'["\'][A-Za-z0-9!@#$%^&*_+=/-]{16,}["\']'), 'assigned secret literal'),
    ]


def build_path_patterns():
    """Personal filesystem paths, which are private and unportable in a published repo."""
    out = []
    for root in HOME_ROOTS:
        out.append((re.compile(r'/' + root + r'/[A-Za-z0-9._-]+/'), 'absolute home directory path'))
    out.append((re.compile(r'(?<![\w/])~/[A-Za-z0-9._-]+/'), 'tilde home directory path'))
    return out


# Files whose whole job is to describe the patterns. Excluding this scanner from the credential
# sweep is necessary and is stated out loud, because an exclusion list is where a real secret
# would eventually hide. Nothing else is excluded from the credential sweep at all.
SELF = {'scripts/privacy_scan.py'}
# The path sweep additionally exempts documents that legitimately talk about home directories
# in prose. It never exempts anything from the credential sweep.
PATH_EXEMPT = {'scripts/privacy_scan.py'}

SKIP_SUFFIXES = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf',
                 '.otf', '.zip', '.gz', '.tar', '.mp4', '.wasm')


def tracked_files(root):
    out = subprocess.run(['git', '-C', root, 'ls-files', '-z'],
                         capture_output=True, check=True)
    return [f for f in out.stdout.decode('utf-8', 'replace').split('\0') if f]


def read_text(path):
    """Read as bytes and decode leniently, so a NUL byte cannot hide the rest of the file."""
    with open(path, 'rb') as fh:
        data = fh.read()
    return data.decode('utf-8', 'replace'), data


def scan_one(rel, text, credential_patterns, path_patterns):
    hits = []
    if rel not in SELF:
        for pattern, label in credential_patterns:
            for m in pattern.finditer(text):
                line = text.count('\n', 0, m.start()) + 1
                hits.append((rel, line, label, m.group(0)[:24]))
    if rel not in PATH_EXEMPT:
        for pattern, label in path_patterns:
            for m in pattern.finditer(text):
                line = text.count('\n', 0, m.start()) + 1
                hits.append((rel, line, label, m.group(0)[:48]))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--min-files', type=int, default=20,
                    help='fail if fewer tracked files than this, since an empty scan looks clean')
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    credential_patterns = build_patterns()
    path_patterns = build_path_patterns()

    try:
        files = tracked_files(root)
    except subprocess.CalledProcessError as exc:
        print('PRIVACY SCAN FAILED: git ls-files did not run: %s' % exc)
        return 1

    if len(files) < args.min_files:
        print('PRIVACY SCAN FAILED: only %d tracked file(s), expected at least %d. A scan over '
              'an empty index reports the same clean result as a scan over a clean tree, so this '
              'is a failure rather than a pass. Commit the tree before scanning it.'
              % (len(files), args.min_files))
        return 1

    hits = []
    read = 0
    bytes_read = 0
    nul_files = 0
    skipped_binary = []
    for rel in files:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        if rel.lower().endswith(SKIP_SUFFIXES):
            skipped_binary.append(rel)
            continue
        text, data = read_text(path)
        if b'\0' in data:
            nul_files += 1
        read += 1
        bytes_read += len(data)
        hits.extend(scan_one(rel, text, credential_patterns, path_patterns))

    # Positive control. A file is written into the scanned tree, in a directory the scan walks,
    # and the scanner has to find it. If it does not, every other result in this run is
    # meaningless and the run fails regardless of what else it did or did not find.
    control_hits = []
    with tempfile.TemporaryDirectory(dir=root, prefix='.privacy-control-') as tmp:
        control_rel = os.path.join(os.path.basename(tmp), 'planted.txt')
        control_path = os.path.join(tmp, 'planted.txt')
        # Assembled at runtime, so no complete credential-shaped literal sits on disk. The NUL
        # is written as an escape rather than embedded, and the control also proves the scan
        # reads past one.
        planted = (
            'token = "' + 'gh' + 'p_' + ('A1b2C3d4E5f6G7h8' * 2) + '"\n'
            + '\0binary looking byte above, text below\n'
            + 'aws = ' + 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP' + '\n'
            + 'path = /' + 'home' + '/somebody/projects/thing/\n'
        )
        with open(control_path, 'w', encoding='utf-8') as fh:
            fh.write(planted)
        text, data = read_text(control_path)
        control_hits = scan_one(control_rel, text, credential_patterns, path_patterns)

    found_labels = {h[2] for h in control_hits}
    wanted = {'GitHub personal access token', 'AWS access key id', 'absolute home directory path',
              'assigned secret literal'}
    missing = wanted - found_labels
    if missing:
        print('PRIVACY SCAN FAILED: the positive control was not detected. The scanner missed: %s'
              % ', '.join(sorted(missing)))
        print('  A scanner that cannot find a credential it planted itself proves nothing about '
              'the %d file(s) it just reported clean.' % read)
        return 1

    print('privacy scan: %d tracked file(s), %d read, %d bytes, %d containing a NUL byte read anyway'
          % (len(files), read, bytes_read, nul_files))
    print('  skipped as binary by extension: %d (%s)'
          % (len(skipped_binary), ', '.join(skipped_binary) if skipped_binary else 'none'))
    print('  positive control detected: %s' % ', '.join(sorted(found_labels)))

    if hits:
        print('PRIVACY SCAN FAILED: %d finding(s) in tracked files' % len(hits))
        for rel, line, label, sample in hits:
            print('  %s:%d %s near %r' % (rel, line, label, sample))
        return 1
    print('PRIVACY SCAN PASSED: no credential-shaped strings and no personal paths in %d files' % read)
    return 0


if __name__ == '__main__':
    sys.exit(main())
