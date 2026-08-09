function normalizeGitRequest(payload) {
  const request = Array.isArray(payload) ? { args: payload } : payload || {};
  const args = Array.isArray(request.args) ? request.args.map(String) : [];
  const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
  return { args, cwd };
}

function isPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isRef(value) {
  return isPath(value) && !value.startsWith('-') && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

function isLogCount(value) {
  if (!/^-[1-9]\d{0,3}$/.test(String(value || ''))) return false;
  return Number(String(value).slice(1)) <= 1000;
}

function exact(args, expected) {
  return args.length === expected.length && expected.every((value, index) => args[index] === value);
}

// commit message 双端上限（M1 安全面：主进程侧硬上限，与前端 maxLength=4096 对齐）
const MAX_COMMIT_MESSAGE_LENGTH = 4096;

function validateGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return 'empty git command';
  const command = args[0];

  if (command === 'status' && (
    exact(args, ['status', '--short', '-z']) || exact(args, ['status', '-sb'])
  )) return null;
  if (command === 'branch' && (
    exact(args, ['branch', '--show-current']) || exact(args, ['branch', '--format=%(refname:short)'])
  )) return null;
  if (command === 'add' && (
    exact(args, ['add', '-A']) || (args.length === 3 && args[1] === '--' && isPath(args[2]))
  )) return null;
  if (command === 'reset' && args.length === 4 && args[1] === 'HEAD' && args[2] === '--' && isPath(args[3])) {
    return null;
  }
  if (command === 'clean' && (
    exact(args, ['clean', '-fd']) || (args.length === 4 && args[1] === '-fd' && args[2] === '--' && isPath(args[3]))
  )) return null;
  if (
    command === 'restore' &&
    args.length >= 6 &&
    exact(args.slice(0, 5), ['restore', '--source=HEAD', '--staged', '--worktree', '--']) &&
    args.slice(5).every(isPath)
  ) return null;
  if (command === 'rev-parse' && exact(args, ['rev-parse', '--verify', 'HEAD'])) return null;
  if (command === 'checkout' && (
    (args.length === 3 && args[1] === '--' && isPath(args[2])) ||
    (args.length === 2 && isRef(args[1])) ||
    (args.length === 3 && args[1] === '-b' && isRef(args[2]))
  )) return null;
  if (command === 'diff' && (
    exact(args, ['diff']) ||
    exact(args, ['diff', '--cached']) ||
    exact(args, ['diff', '--numstat']) ||
    exact(args, ['diff', '--cached', '--numstat']) ||
    (args.length === 3 && args[1] === '--' && isPath(args[2])) ||
    (args.length === 4 && args[1] === '--cached' && args[2] === '--' && isPath(args[3]))
  )) return null;
  if (command === 'commit' && args.length === 3 && args[1] === '-m' && isPath(args[2])) {
    if (args[2].length > MAX_COMMIT_MESSAGE_LENGTH) {
      return 'commit message exceeds 4096 characters';
    }
    return null;
  }
  if (command === 'log' && isLogCount(args[1]) && (
    exact(args.slice(2), ['--oneline', '--decorate']) ||
    exact(args.slice(2), ['--format=%H|%h|%an|%ai|%s'])
  )) return null;
  if (command === 'stash' && (
    exact(args, ['stash']) || exact(args, ['stash', 'pop']) || exact(args, ['stash', 'list'])
  )) return null;
  if (command === 'push' && (
    exact(args, ['push']) || (args.length === 4 && args[1] === '-u' && args[2] === 'origin' && isRef(args[3]))
  )) return null;
  if ((command === 'pull' || command === 'fetch') && args.length === 1) return null;
  if (command === 'remote' && exact(args, ['remote', 'get-url', 'origin'])) return null;

  return `git ${command || '<empty>'} command shape is not allowed: ${args.join(' ') || '<empty>'}`;
}

module.exports = {
  normalizeGitRequest,
  validateGitArgs,
};
