#!/usr/bin/env python3
"""Prove that checks/check_independent.py shares nothing with the package it judges.

Why this exists: a validator that reuses the code it validates cannot catch that code's bugs.
It inherits them and reports clean. The independent checker is only worth running if it really
is independent, and "really" has to be machine checked, because a human reading the imports
once at review time does not keep it true six months later.

Why `ast` and not `grep`:
  - a grep for "import" is satisfied by the word appearing in a comment or a docstring
  - a grep misses importlib.import_module('...'), __import__('...'), and exec of a string
  - a grep misses subprocess.run(['node', 'bin/legible.js', ...]), which would make the
    "independent" checker a thin wrapper around the thing under test

So the file is parsed, its import graph is walked transitively through any local module it
pulls in, and every module reached must be in the Python standard library. On top of that the
syntax tree is searched for the escape hatches that would let the package back in through a
side door.

Exit code 0 means independence holds.
"""

import argparse
import ast
import os
import sys

# Anything that can load or run code that is not a plain stdlib import.
FORBIDDEN_CALLS = {
    '__import__': 'imports a module by name at runtime',
    'eval': 'runs a string as code',
    'exec': 'runs a string as code',
    'compile': 'turns a string into code',
    'importlib.import_module': 'imports a module by name at runtime',
    'importlib.__import__': 'imports a module by name at runtime',
    'os.system': 'runs a shell command',
    'os.popen': 'runs a shell command',
    'os.execv': 'replaces this process with another program',
    'os.execvp': 'replaces this process with another program',
    'os.spawnv': 'runs another program',
    'subprocess.run': 'runs another program',
    'subprocess.call': 'runs another program',
    'subprocess.check_call': 'runs another program',
    'subprocess.check_output': 'runs another program',
    'subprocess.Popen': 'runs another program',
    'runpy.run_path': 'runs another Python file',
}

FORBIDDEN_MODULES = {'subprocess', 'importlib', 'runpy', 'ctypes', 'multiprocessing'}


def dotted(node):
    """Render an ast expression as a dotted name, or None."""
    parts = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return '.'.join(reversed(parts))
    return None


def imports_of(tree):
    """Every module name this file imports, from the syntax tree rather than from text."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append((alias.name, node.lineno))
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                found.append(('.' * node.level + (node.module or ''), node.lineno))
            elif node.module:
                found.append((node.module, node.lineno))
    return found


def suspicious_calls(tree):
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = dotted(node.func)
        if name is None:
            continue
        if name in FORBIDDEN_CALLS:
            out.append((name, FORBIDDEN_CALLS[name], node.lineno))
        # A bare attribute call on a forbidden module, e.g. subprocess.anything(...)
        root = name.split('.')[0]
        if root in FORBIDDEN_MODULES and name not in FORBIDDEN_CALLS:
            out.append((name, 'reaches into %s' % root, node.lineno))
    return out


def local_module_path(module, search_dirs):
    """Resolve a module name to a file inside this project, or None if it is not ours."""
    rel = module.replace('.', os.sep)
    for base in search_dirs:
        for candidate in (os.path.join(base, rel + '.py'), os.path.join(base, rel, '__init__.py')):
            if os.path.isfile(candidate):
                return candidate
    return None


def walk_graph(entry, project_root):
    """Transitively parse entry and every local module it imports."""
    search_dirs = [os.path.dirname(os.path.abspath(entry)), project_root]
    seen = {}
    queue = [os.path.abspath(entry)]
    problems = []
    external = set()

    while queue:
        path = queue.pop()
        if path in seen:
            continue
        with open(path, encoding='utf-8') as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
        seen[path] = tree
        rel = os.path.relpath(path, project_root)

        for name, why, lineno in suspicious_calls(tree):
            problems.append('%s:%d calls %s, which %s' % (rel, lineno, name, why))

        for module, lineno in imports_of(tree):
            top = module.lstrip('.').split('.')[0]
            if module.startswith('.'):
                problems.append('%s:%d uses a relative import %r, which means it is part of a '
                                'package rather than standing alone' % (rel, lineno, module))
                continue
            if top in FORBIDDEN_MODULES:
                problems.append('%s:%d imports %s, which can run the package under test'
                                % (rel, lineno, module))
                continue
            local = local_module_path(module, search_dirs)
            if local:
                queue.append(os.path.abspath(local))
                continue
            if top not in sys.stdlib_module_names:
                external.add(module)
                problems.append('%s:%d imports %r, which is not in the Python standard library '
                                'and is not a local module this walk can vouch for'
                                % (rel, lineno, module))
    return seen, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--entry', required=True, help='the independent checker to prove')
    ap.add_argument('--project-root', required=True)
    ap.add_argument('--package', action='append', default=[],
                    help='a directory holding the package under test; may be repeated')
    args = ap.parse_args()

    root = os.path.abspath(args.project_root)
    entry = os.path.abspath(args.entry)
    if not os.path.isfile(entry):
        print('INDEPENDENCE PROOF FAILED: %s does not exist' % args.entry)
        return 1

    seen, problems = walk_graph(entry, root)

    # A walk that parsed nothing proves nothing, so the count is asserted rather than assumed.
    if len(seen) < 1:
        print('INDEPENDENCE PROOF FAILED: the import walk parsed no files')
        return 1

    # And the entry file has to be substantial. A one line checker that imports nothing would
    # pass this proof while checking nothing, so the proof reports the size it vouched for.
    total_nodes = sum(len(list(ast.walk(tree))) for tree in seen.values())
    if total_nodes < 500:
        problems.append('the walked graph has only %d syntax nodes, which is too small to be '
                        'the independent checker' % total_nodes)

    # Nothing in the graph may name a file inside the package under test as something to open.
    package_dirs = [os.path.normpath(p) for p in args.package]
    for path, tree in seen.items():
        rel = os.path.relpath(path, root)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                value = node.value
                # A path inside the package, not a bare word that happens to match a directory
                # name. The independent checker reads HTML, so the string 'src' appears in it
                # constantly as an attribute name and is not a reference to src/.
                for pkg in package_dirs:
                    if value.startswith(pkg + '/') or value.startswith('./' + pkg + '/'):
                        problems.append('%s:%d mentions %r, a path inside the package under test'
                                        % (rel, getattr(node, 'lineno', 0), value))
                if value.endswith(('.js', '.mjs', '.cjs')):
                    problems.append('%s:%d mentions %r, a JavaScript file from the package under test'
                                    % (rel, getattr(node, 'lineno', 0), value))

    print('independence proof: walked %d file(s), %d syntax nodes, from %s'
          % (len(seen), total_nodes, os.path.relpath(entry, root)))
    for path in sorted(seen):
        print('  parsed %s' % os.path.relpath(path, root))

    if problems:
        print('INDEPENDENCE PROOF FAILED: %d problem(s)' % len(problems))
        for p in problems:
            print('  %s' % p)
        return 1
    print('INDEPENDENCE PROOF PASSED: every import resolves to the Python standard library, '
          'and nothing in the graph can load or run the package under test')
    return 0


if __name__ == '__main__':
    sys.exit(main())
