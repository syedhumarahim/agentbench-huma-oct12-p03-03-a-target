"""Run real local checks and optionally publish exact-commit GitHub statuses.

No hosted runner, workflow, Actions API or external CI service is used.
This helper does not implement or grade the governance CLI itself.
"""
import argparse, hashlib, json, re, shutil, subprocess, urllib.request
from pathlib import Path

COMMANDS = {'test': ['npm', 'test'], 'package': ['npm', 'run', 'package']}

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE).decode().strip()

def snapshot(root):
    return git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain', '--untracked-files=normal')

def repository(root):
    match = re.fullmatch(r'https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?', git(root, 'remote', 'get-url', 'origin'))
    if not match: raise ValueError('Origin must be a credential-free GitHub HTTPS URL')
    return match.group(1)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected API redirect; no credential forwarded')

def api(repo, suffix, token, body=None):
    request = urllib.request.Request('https://api.github.com/repos/' + repo + '/' + suffix,
        None if body is None else json.dumps(body).encode(),
        {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
         'Content-Type': 'application/json', 'User-Agent': 'CE3-local-checks'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            return json.load(response)
    except Exception:
        raise RuntimeError('GitHub status operation failed; inspect access/connectivity without exposing the token') from None

def execute(root, local_only=False, token_file=None):
    root = Path(root).resolve()
    sha, dirty = snapshot(root)
    if dirty: raise ValueError('Commit all task changes before checking; the working tree must be clean')
    tracked = git(root, 'ls-tree', '-r', '--name-only', 'HEAD').splitlines()
    if any(p.startswith('.github/workflows/') for p in tracked):
        raise ValueError('Workflow files are outside this no-Actions delivery')
    npm = shutil.which('npm')
    if not npm: raise ValueError('npm is required')
    repo = repository(root) if not local_only else None
    token = ''
    if not local_only:
        if token_file is None: raise ValueError('--token-file is required when publishing statuses')
        token = Path(token_file).read_text().strip()
        if not token or any(c.isspace() for c in token): raise ValueError('Assigned credential is malformed')
        if api(repo, 'commits/' + sha, token).get('sha') != sha:
            raise ValueError('Push this exact commit before publishing its statuses')
        for context in COMMANDS:
            api(repo, 'statuses/' + sha, token, {'state': 'pending', 'context': context,
                'description': 'Local verification in progress; no Actions runner'})
    folder = root / 'artifacts/local-checks'
    folder.mkdir(parents=True, exist_ok=True)
    results = []
    for context, command in COMMANDS.items():
        try:
            result = subprocess.run([npm, *command[1:]], cwd=root, capture_output=True, timeout=900)
            returncode, output = result.returncode, result.stdout + result.stderr
        except (OSError, subprocess.TimeoutExpired):
            returncode, output = 124, b'Local check could not complete within the allowed runtime.\n'
        if token: output = output.replace(token.encode(), b'[REDACTED]')
        log = folder / (sha + '-' + context + '.log')
        log.write_bytes(output)
        results.append({'context': context, 'command': command, 'exit_code': returncode,
                        'log': log.relative_to(root).as_posix(), 'log_sha256': hashlib.sha256(output).hexdigest()})
    final_sha, final_dirty = snapshot(root)
    unchanged = final_sha == sha and not final_dirty
    for item in results:
        item['state'] = 'success' if unchanged and item['exit_code'] == 0 else 'failure'
        if not local_only:
            api(repo, 'statuses/' + sha, token, {'state': item['state'], 'context': item['context'],
                'description': 'Local ' + item['context'] + '; evidence ' + item['log_sha256'][:12]})
    report = {'sha': sha, 'repository': repo, 'source_unchanged': unchanged, 'checks': results,
              'passed': unchanged and all(i['state'] == 'success' for i in results),
              'statuses_published': not local_only, 'runner': 'local; GitHub Commit Statuses API only'}
    (folder / (sha + '.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return report

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--local-only', action='store_true')
    parser.add_argument('--token-file', type=Path)
    args = parser.parse_args()
    try:
        result = execute(Path.cwd(), args.local_only, args.token_file)
        raise SystemExit(0 if result['passed'] else 1)
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
