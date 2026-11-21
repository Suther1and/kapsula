#!/usr/bin/env node
/**
 * Clean public GitHub publisher & strict secret/privacy auditor for Kapsula.
 *
 * Exports a clean snapshot of `main` (or `--ref <git-ref>`) into a temporary git
 * repository, excluding private/local directories (`_bmad-output/`, `_bmad/`,
 * `AGENTS.md`, `release/`, `dist/`, `.env*`, keystores, SQLite files, etc.),
 * scans EVERY exported file for leaked secrets or personal data, and optionally
 * pushes an orphan (first push) or incremental (subsequent pushes) clean commit
 * + optional release tag to `https://github.com/Suther1and/kapsula.git`.
 *
 * Default mode is `--dry-run` (never touches the remote unless `--push` is passed).
 *
 * Usage:
 *   node scripts/publish-clean-github.mjs --dry-run
 *   node scripts/publish-clean-github.mjs --dry-run --ref HEAD --tag v1.0.1
 *   node scripts/publish-clean-github.mjs --push --tag v1.0.1
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_REMOTE = 'https://github.com/Suther1and/kapsula.git';
const DEFAULT_BRANCH = 'main';
const DEFAULT_REF = 'main';
const DEFAULT_AUTHOR_NAME = 'Suther1and';
const DEFAULT_AUTHOR_EMAIL = 'Suther1and@users.noreply.github.com';

const EXCLUDED_TOP_DIRS = new Set([
  '_bmad-output',
  '_bmad',
  '.impeccable',
  '.tmp',
  'release',
  'dist',
  'dist-electron',
  'node_modules',
  'coverage',
  'test-results',
]);

// Key public showcase & GitHub Pages files that must always pass through untouched
const PUBLIC_SHOWCASE_PATHS = [
  'README.md',
  'LICENSE',
  'docs/index.html',
  'docs/styles.css',
  'docs/app.js',
];

// SHA-256 digests (domain-separated with "kapsula-personal-guard-v1:") of private author
// identifiers, paths, email prefixes, and personal phrases — stored hashed so the guard works
// on every machine/CI runner without ever exposing personal strings in this public script.
const PERSONAL_GUARD_DOMAIN = 'kapsula-personal-guard-v1:';
const BLOCKED_PERSONAL_TOKEN_SHA256 = new Set([
  '35557e5afc3545b1ab7f9ebcfecf967c875ad083af134c718f524046eab1607b',
  '90eb272c99fd5086385ef4e0a8f72d212f0e7c2c8e0032762b1f4ef3c376ad62',
  '31ae2af9975f67e8b14bc827328b089bb9284d7555242bf532a09a05a00c3825',
]);
const BLOCKED_PERSONAL_EMAIL_PREFIX_SHA256 = new Set([
  '4ab6c7b94dff0b04f24440ab1bb36e82c385f515187953d3476c82e86ca033a0',
]);
const BLOCKED_PERSONAL_PATH_SHA256 = new Set([
  '9e06dc3a121ebf1f84885ebf144bf3b12c22e6a3ca892d24e6bcd17f5d527e5b',
]);
const BLOCKED_PERSONAL_PHRASE_SHA256 = new Set([
  '0e54270f6ca639f0f63d3b8740d4fb93aeec0c4e58c688fd9047d8aec8ac756d',
]);

function personalGuardDigest(value) {
  return crypto
    .createHash('sha256')
    .update(PERSONAL_GUARD_DOMAIN + value.toLowerCase().trim())
    .digest('hex');
}

const EXCLUDED_EXACT_PATHS = new Set([
  'AGENTS.md',
  'android/local.properties',
  'keystore-env.json',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.jks',
  '.keystore',
  '.p12',
  '.pfx',
  '.pem',
  '.key',
  '.sqlite',
  '.sqlite3',
  '.sqlite-wal',
  '.sqlite-shm',
  '.db-wal',
  '.db-shm',
  '.dpapi',
  '.log',
]);

// Intentional public client identifiers (Supabase anon/publishable key protected by RLS)
const PUBLIC_CLIENT_MARKERS = [
  'gxkvuwipzbqocbxgyqty.supabase.co',
  'sb_publishable_',
];

// Files allowed to contain redaction regexes or short synthetic PEM headers (never real key material)
const PEM_HEADER_ALLOWLIST_FILES = new Set([
  'src/main/security/secret-shield.ts',
  'src/main/ai/text-studio.ts',
  'src/mobile/lib/mobile-ai.ts',
  'tests/secret-shield.test.ts',
  'scripts/publish-clean-github.mjs',
]);

// SHA-256 of the canonical RFC 7519 example JWT used in tests/secret-shield.test.ts
const RFC7519_EXAMPLE_JWT_SHA256 =
  '3908a0662c6e684ad678756fac43a62e10f5a6fb23bdbd1778dd816edeb6f704';

const SYNTHETIC_TEST_EMAIL_LOCALS = new Set([
  'user',
  'v7user',
  'cal-user',
  'support',
  'alex',
  'test',
  'demo',
]);

function printUsage() {
  console.log(`Usage: node scripts/publish-clean-github.mjs [options]

Options:
  --dry-run                 Audit & verify clean export locally without pushing (default)
  --push                    Push clean commit to public GitHub remote after passing all audits
  --tag <vX.Y.Z>            Validate (dry-run) or create & push annotated release tag
  --ref <git-ref>           Source git ref to export (default: ${DEFAULT_REF})
  --remote <url>            Public GitHub remote URL (default: ${DEFAULT_REMOTE})
  --branch <name>           Target remote branch (default: ${DEFAULT_BRANCH})
  --message <text>          Custom commit message
  --author-name <name>      Public commit author name (default: ${DEFAULT_AUTHOR_NAME})
  --author-email <email>    Public commit author email (default: ${DEFAULT_AUTHOR_EMAIL})
  --allow-version-mismatch  Allow --tag version to differ from package.json version
  --keep-temp               Preserve temporary export directory for manual inspection
  -h, --help                Show this help
`);
}

function parseArgs(argv) {
  const opts = {
    push: false,
    dryRun: true,
    tag: null,
    ref: DEFAULT_REF,
    remote: DEFAULT_REMOTE,
    branch: DEFAULT_BRANCH,
    message: null,
    authorName: DEFAULT_AUTHOR_NAME,
    authorEmail: DEFAULT_AUTHOR_EMAIL,
    allowVersionMismatch: false,
    keepTemp: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
      opts.push = false;
    } else if (arg === '--push') {
      opts.push = true;
      opts.dryRun = false;
    } else if (arg === '--allow-version-mismatch') {
      opts.allowVersionMismatch = true;
    } else if (arg === '--keep-temp') {
      opts.keepTemp = true;
    } else if (arg === '--tag' && argv[i + 1]) {
      opts.tag = argv[++i].trim();
    } else if (arg.startsWith('--tag=')) {
      opts.tag = arg.slice('--tag='.length).trim();
    } else if (arg === '--ref' && argv[i + 1]) {
      opts.ref = argv[++i].trim();
    } else if (arg.startsWith('--ref=')) {
      opts.ref = arg.slice('--ref='.length).trim();
    } else if (arg === '--remote' && argv[i + 1]) {
      opts.remote = argv[++i].trim();
    } else if (arg.startsWith('--remote=')) {
      opts.remote = arg.slice('--remote='.length).trim();
    } else if (arg === '--branch' && argv[i + 1]) {
      opts.branch = argv[++i].trim();
    } else if (arg.startsWith('--branch=')) {
      opts.branch = arg.slice('--branch='.length).trim();
    } else if (arg === '--message' && argv[i + 1]) {
      opts.message = argv[++i];
    } else if (arg.startsWith('--message=')) {
      opts.message = arg.slice('--message='.length);
    } else if (arg === '--author-name' && argv[i + 1]) {
      opts.authorName = argv[++i];
    } else if (arg === '--author-email' && argv[i + 1]) {
      opts.authorEmail = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (opts.tag && !/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(opts.tag)) {
    throw new Error(`Invalid release tag "${opts.tag}". Expected semantic tag like v1.0.1`);
  }

  return opts;
}

function git(args, { cwd = process.cwd(), env = process.env, input, encoding = 'utf8' } = {}) {
  const execOpts = {
    cwd,
    env,
    input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (encoding && encoding !== 'buffer') {
    execOpts.encoding = encoding;
  }
  return execFileSync('git', args, execOpts);
}

function classifyExclusion(posixPath) {
  const parts = posixPath.split('/');
  const top = parts[0];
  const base = parts[parts.length - 1];
  const ext = path.posix.extname(base).toLowerCase();

  if (EXCLUDED_TOP_DIRS.has(top)) {
    return `dir:${top}/`;
  }
  if (/^release-/i.test(top)) {
    return `dir:${top}/`;
  }
  if (EXCLUDED_EXACT_PATHS.has(posixPath) || EXCLUDED_EXACT_PATHS.has(base)) {
    return `file:${posixPath}`;
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return 'pattern:.env*';
  }
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return `ext:${ext}`;
  }
  if (
    parts.some(
      (seg) =>
        seg === '_bmad-output' ||
        seg === '_bmad' ||
        seg === '.impeccable' ||
        seg === 'node_modules' ||
        seg === '.tmp',
    )
  ) {
    return 'nested-private-dir';
  }
  return null;
}

function listTreeEntries(repoRoot, ref) {
  const raw = git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', ref], {
    cwd: repoRoot,
    encoding: 'buffer',
  });
  const entries = [];
  let offset = 0;
  while (offset < raw.length) {
    const nulIdx = raw.indexOf(0, offset);
    if (nulIdx === -1) break;
    const record = raw.subarray(offset, nulIdx).toString('utf8');
    offset = nulIdx + 1;
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).split(' ');
    const filePath = record.slice(tabIdx + 1);
    entries.push({
      mode: meta[0],
      type: meta[1],
      sha: meta[2],
      path: filePath,
    });
  }
  return entries;
}

function readBlobsBatch(repoRoot, entries) {
  if (entries.length === 0) return new Map();
  const input = entries.map((e) => e.sha).join('\n') + '\n';
  const out = git(['cat-file', '--batch'], {
    cwd: repoRoot,
    input,
    encoding: 'buffer',
  });

  const blobs = new Map();
  let pos = 0;
  for (const entry of entries) {
    const nl = out.indexOf(0x0a, pos);
    if (nl === -1) {
      throw new Error(`Unexpected EOF reading git blob header for ${entry.path}`);
    }
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing') {
      throw new Error(`Missing git blob ${entry.sha} for ${entry.path}`);
    }
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid blob size in git cat-file header: ${header}`);
    }
    const content = out.subarray(pos, pos + size);
    pos += size + 1; // trailing LF after each object in cat-file --batch
    blobs.set(entry.path, content);
  }
  return blobs;
}

function isBinaryBuffer(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function redactPreview(raw) {
  if (raw.length <= 10) return `${raw.slice(0, 3)}***`;
  return `${raw.slice(0, 6)}***(${raw.length} chars)`;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isTestOrVerifierFile(posixPath) {
  return posixPath.startsWith('tests/') || /^scripts\/verify-.*\.m?js$/i.test(posixPath);
}

function isSyntheticFixtureToken(ruleId, token, posixPath) {
  if (!isTestOrVerifierFile(posixPath)) return false;

  if (ruleId === 'supabase-pat') {
    return posixPath.startsWith('tests/') && /(?:test|mock|fake|dummy|example|1234567890)/i.test(token);
  }
  if (ruleId === 'github-pat') {
    return /(?:1234567890|9876543210|super_secret|SuperSecret|LiveProductionSecret|TestToken|MockToken|FakeToken|DummyToken)/i.test(
      token,
    );
  }
  if (ruleId === 'google-ai-key') {
    return /^AIza(?:Sy)?(?:Test|Mock|Fake|Dummy)/i.test(token) || /(?:00001|1234567890)/.test(token);
  }
  if (ruleId === 'openrouter-key') {
    return /(?:test|mock|fake|dummy|secret|example|1234567890|9876543210|9988776655|abcdefghij)/i.test(token);
  }
  if (ruleId === 'provider-secret-key') {
    return posixPath.startsWith('tests/') && /(?:abcdefghij|1234567890|test|mock|fake|dummy)/i.test(token);
  }
  if (ruleId === 'jwt-token') {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return posixPath === 'tests/secret-shield.test.ts' && hash === RFC7519_EXAMPLE_JWT_SHA256;
  }
  if (ruleId === 'personal-email') {
    const [localPart] = token.toLowerCase().split('@');
    return posixPath.startsWith('tests/') && SYNTHETIC_TEST_EMAIL_LOCALS.has(localPart);
  }
  return false;
}

function buildSecurityRules() {
  const rules = [
    {
      id: 'supabase-pat',
      label: 'Supabase Personal Access Token (sbp_)',
      regex: /\bsbp_[A-Za-z0-9]{16,}\b/g,
      strict: false,
    },
    {
      id: 'supabase-secret-key',
      label: 'Supabase Secret / Service Key (sb_secret_)',
      regex: /\bsb_secret_[A-Za-z0-9_-]{12,}\b/g,
      strict: true,
    },
    {
      id: 'github-pat',
      label: 'GitHub Personal Access Token',
      regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      strict: false,
    },
    {
      id: 'google-ai-key',
      label: 'Google AI / Gemini API Key (AIza...)',
      regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
      strict: false,
    },
    {
      id: 'openrouter-key',
      label: 'OpenRouter API Key (sk-or-...)',
      regex: /\bsk-or-[A-Za-z0-9_-]{16,}\b/g,
      strict: false,
    },
    {
      id: 'provider-secret-key',
      label: 'OpenAI / Anthropic Secret API Key',
      regex: /\bsk-(?:proj-|ant-api\d+-)[A-Za-z0-9_-]{20,}\b/g,
      strict: false,
    },
    {
      id: 'google-oauth-secret',
      label: 'Google OAuth Client Secret (GOCSPX-...)',
      regex: /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/g,
      strict: true,
    },
    {
      id: 'pem-private-key-body',
      label: 'PEM Private Key Material',
      regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\r?\\n|\r?\n)+(?:[A-Za-z0-9+/=]{24,}(?:\\r?\\n|\r?\n)*)+/g,
      strict: true,
    },
    {
      id: 'pem-private-key-header',
      label: 'Unexpected PEM Private Key Header',
      regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
      skipFiles: PEM_HEADER_ALLOWLIST_FILES,
      strict: true,
    },
    {
      id: 'jwt-token',
      label: 'Signed JWT Token',
      regex: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g,
      strict: false,
    },
    {
      id: 'windows-user-path',
      label: 'Personal Windows User Path',
      regex: /[A-Za-z]:\\{1,2}Users\\{1,2}(?!Public\b|Default\b|runneradmin\b|alice\b|user\b|username\b)[^\\\s"'`<>]+/gi,
      strict: true,
    },
    {
      id: 'macos-user-path',
      label: 'Personal macOS User Path',
      regex: /\/Users\/(?!Shared\b|runner\b|username\b)[^/\s"'`<>]+/gi,
      strict: true,
    },
    {
      id: 'personal-email',
      label: 'Personal Email Address',
      regex:
        /\b[A-Za-z0-9._%+-]+@(?:gmail\.com|yandex\.ru|ya\.ru|mail\.ru|bk\.ru|inbox\.ru|list\.ru|icloud\.com|outlook\.com|hotmail\.com|proton\.me|protonmail\.com)\b/gi,
      strict: false,
    },
    {
      id: 'private-signing-dir',
      label: 'Local Android Signing Directory Reference',
      regex: new RegExp('\\bKapsula' + '-Signing\\b', 'gi'),
      strict: true,
    },
    {
      id: 'private-bmad-output-ref',
      label: 'Private _bmad-output Reference',
      regex: new RegExp('_bmad' + '-output\\b', 'gi'),
      skipFiles: new Set(['scripts/publish-clean-github.mjs', 'scripts/pack-mac-zip.mjs']),
      strict: true,
    },
  ];

  // Dynamically guard against leaking the current machine's OS username without hardcoding it
  try {
    const osUser = os.userInfo().username;
    const genericNames = new Set(['root', 'admin', 'administrator', 'user', 'runner', 'runneradmin', 'codespace']);
    if (osUser && osUser.length >= 4 && !genericNames.has(osUser.toLowerCase())) {
      const escaped = osUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push({
        id: 'local-os-username',
        label: 'Local OS Username Leakage',
        regex: new RegExp(`\\b${escaped}\\b`, 'gi'),
        strict: true,
      });
    }
  } catch {
    // ignore if os.userInfo() unavailable
  }

  return rules;
}

function walkExportedFiles(rootDir, relPrefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (relPrefix === '' && entry.name === '.git') continue;
    const absPath = path.join(rootDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkExportedFiles(absPath, relPath));
    } else if (entry.isFile()) {
      results.push({ absPath, relPath });
    }
  }
  return results;
}

function scanPersonalLeakDigests(text, relPath, violations) {
  const checks = [
    {
      rule: 'personal-path-digest',
      label: 'Blocked Personal User Path',
      regex: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`<>]+/gi,
      normalize: (s) => s.replace(/\\\\/g, '\\'),
      digests: BLOCKED_PERSONAL_PATH_SHA256,
    },
    {
      rule: 'personal-email-digest',
      label: 'Blocked Personal Email Prefix',
      regex: /[A-Za-z0-9._%+-]+@/g,
      normalize: (s) => s,
      digests: BLOCKED_PERSONAL_EMAIL_PREFIX_SHA256,
    },
    {
      rule: 'personal-token-digest',
      label: 'Blocked Personal Identifier',
      regex: /\b[A-Za-z0-9_]{4,}\b/g,
      normalize: (s) => s,
      digests: BLOCKED_PERSONAL_TOKEN_SHA256,
    },
    {
      rule: 'personal-phrase-digest',
      label: 'Blocked Personal Phrase',
      regex: /\b[A-Za-zА-Яа-яЁё]{3,}[\s_-]+[A-Za-zА-Яа-яЁё]{3,}\b/g,
      normalize: (s) => s.replace(/[\s_-]+/g, ' '),
      digests: BLOCKED_PERSONAL_PHRASE_SHA256,
    },
  ];

  for (const check of checks) {
    check.regex.lastIndex = 0;
    let match;
    while ((match = check.regex.exec(text)) !== null) {
      const normalized = check.normalize(match[0]);
      if (check.digests.has(personalGuardDigest(normalized))) {
        violations.push({
          file: relPath,
          line: lineNumberAt(text, match.index),
          rule: check.rule,
          label: check.label,
          preview: redactPreview(match[0]),
        });
      }
      // For two-word phrases, step back to the start of the second word so overlapping pairs
      // like "word alpha beta" still inspect "alpha beta".
      if (check.rule === 'personal-phrase-digest') {
        const sepMatch = /[\s_-]+/.exec(match[0]);
        if (sepMatch) {
          check.regex.lastIndex = match.index + sepMatch.index + sepMatch[0].length;
        }
      }
    }
  }
}

function auditExportedDirectory(exportDir) {
  const files = walkExportedFiles(exportDir);
  const rules = buildSecurityRules();
  const violations = [];
  const allowlistedFixtures = new Map();
  const publicClientHits = new Set();

  let textFilesScanned = 0;
  let binaryFilesSkipped = 0;

  for (const { absPath, relPath } of files) {
    const pathReason = classifyExclusion(relPath);
    if (pathReason) {
      violations.push({
        file: relPath,
        line: 0,
        rule: 'forbidden-path',
        label: `Forbidden path leaked into export (${pathReason})`,
        preview: relPath,
      });
      continue;
    }

    const buf = fs.readFileSync(absPath);
    if (isBinaryBuffer(buf)) {
      binaryFilesSkipped += 1;
      continue;
    }

    textFilesScanned += 1;
    const text = buf.toString('utf8');

    for (const marker of PUBLIC_CLIENT_MARKERS) {
      if (text.includes(marker)) {
        publicClientHits.add(`${marker} (${relPath})`);
      }
    }

    for (const rule of rules) {
      if (rule.skipFiles && rule.skipFiles.has(relPath)) continue;
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(text)) !== null) {
        const token = match[0];
        if (!rule.strict && isSyntheticFixtureToken(rule.id, token, relPath)) {
          allowlistedFixtures.set(relPath, (allowlistedFixtures.get(relPath) || 0) + 1);
          continue;
        }
        violations.push({
          file: relPath,
          line: lineNumberAt(text, match.index),
          rule: rule.id,
          label: rule.label,
          preview: redactPreview(token),
        });
      }
    }

    scanPersonalLeakDigests(text, relPath, violations);
  }

  return {
    totalFiles: files.length,
    textFilesScanned,
    binaryFilesSkipped,
    violations,
    allowlistedFixtures,
    publicClientHits: Array.from(publicClientHits).sort(),
  };
}

function buildGitAuthEnv(remoteUrl) {
  const env = { ...process.env };
  if (!/^https:\/\/github\.com\//i.test(remoteUrl)) {
    return env;
  }

  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      token = '';
    }
  }

  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function clearWorkingTreeExceptGit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function writeExportTree(targetDir, keptEntries, blobs) {
  for (const entry of keptEntries) {
    const dst = path.join(targetDir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, blobs.get(entry.path));
  }
}

function stageAndPreserveModes(tempDir, keptEntries) {
  git(['add', '-A'], { cwd: tempDir });
  const execPaths = keptEntries.filter((e) => e.mode === '100755').map((e) => e.path);
  for (const posixPath of execPaths) {
    git(['update-index', '--chmod=+x', '--', posixPath], { cwd: tempDir });
  }
  return execPaths;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
  const sourceSha = git(['rev-parse', '--verify', `${opts.ref}^{commit}`], { cwd: repoRoot }).trim();

  const allEntries = listTreeEntries(repoRoot, opts.ref);
  const keptEntries = [];
  const excludedCounts = new Map();

  for (const entry of allEntries) {
    if (entry.type !== 'blob') continue;
    const reason = classifyExclusion(entry.path);
    if (reason) {
      excludedCounts.set(reason, (excludedCounts.get(reason) || 0) + 1);
    } else {
      keptEntries.push(entry);
    }
  }

  const blobs = readBlobsBatch(repoRoot, keptEntries);
  const pkgRaw = blobs.get('package.json');
  if (!pkgRaw) {
    throw new Error('Exported tree is missing package.json');
  }
  const pkg = JSON.parse(pkgRaw.toString('utf8'));
  const pkgVersion = pkg.version || '0.0.0';

  if (opts.tag && !opts.allowVersionMismatch) {
    const expectedTag = `v${pkgVersion}`;
    if (opts.tag !== expectedTag) {
      throw new Error(
        `Tag "${opts.tag}" does not match package.json version "${pkgVersion}" (expected "${expectedTag}"). Pass --allow-version-mismatch to override.`,
      );
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-public-sync-'));
  let pushModeLabel = 'dry-run (local verification only)';
  let publicCommitSha = null;
  let committedNewChanges = false;
  let tagPushed = false;

  try {
    const authEnv = opts.push ? buildGitAuthEnv(opts.remote) : process.env;
    let remoteHasBranch = false;

    if (opts.push) {
      const lsRemote = git(['ls-remote', '--heads', opts.remote, `refs/heads/${opts.branch}`], {
        cwd: tempDir,
        env: authEnv,
      }).trim();
      remoteHasBranch = lsRemote.length > 0;
    }

    git(['init', '-b', opts.branch], { cwd: tempDir });
    git(['config', 'core.autocrlf', 'false'], { cwd: tempDir });
    git(['config', 'core.quotepath', 'false'], { cwd: tempDir });
    git(['config', 'user.name', opts.authorName], { cwd: tempDir });
    git(['config', 'user.email', opts.authorEmail], { cwd: tempDir });

    if (opts.push && remoteHasBranch) {
      git(['remote', 'add', 'origin', opts.remote], { cwd: tempDir });
      git(['fetch', '--depth=1', 'origin', opts.branch], { cwd: tempDir, env: authEnv });
      git(['checkout', '-B', opts.branch, 'FETCH_HEAD'], { cwd: tempDir });
      clearWorkingTreeExceptGit(tempDir);
    } else if (opts.push) {
      git(['remote', 'add', 'origin', opts.remote], { cwd: tempDir });
    }

    writeExportTree(tempDir, keptEntries, blobs);

    // Run strict security & privacy audit on the exact exported files BEFORE any commit/push
    const audit = auditExportedDirectory(tempDir);

    console.log('=== Kapsula Clean Public GitHub Export Audit ===');
    console.log(`Mode:                ${opts.push ? 'PUSH' : 'DRY-RUN'}`);
    console.log(`Source ref:          ${opts.ref} (${sourceSha.slice(0, 12)})`);
    console.log(`Package version:     ${pkgVersion}${opts.tag ? ` | Requested tag: ${opts.tag}` : ''}`);
    console.log(`Target remote:       ${opts.remote} (${opts.branch})`);
    console.log(
      `Files exported:      ${audit.totalFiles} (${audit.textFilesScanned} text scanned, ${audit.binaryFilesSkipped} binary assets)`,
    );
    const excludedTotal = Array.from(excludedCounts.values()).reduce((a, b) => a + b, 0);
    console.log(`Files excluded:      ${excludedTotal}`);
    for (const [reason, count] of Array.from(excludedCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  - ${reason}: ${count}`);
    }
    const exportedPathsSet = new Set(keptEntries.map((e) => e.path));
    const showcasePresent = PUBLIC_SHOWCASE_PATHS.filter((p) => exportedPathsSet.has(p));
    const docsCount = keptEntries.filter((e) => e.path.startsWith('docs/')).length;
    console.log(
      `Public showcase:     ${showcasePresent.length}/${PUBLIC_SHOWCASE_PATHS.length} core files (${showcasePresent.join(', ') || 'none'}) | docs/ assets: ${docsCount}`,
    );
    if (audit.publicClientHits.length > 0) {
      console.log(`Public client keys confirmed (RLS-protected): ${audit.publicClientHits.length}`);
    }
    if (audit.allowlistedFixtures.size > 0) {
      const fixtureSummary = Array.from(audit.allowlistedFixtures.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([f, n]) => `${f} (${n})`)
        .join(', ');
      console.log(`Synthetic test fixtures allowlisted: ${fixtureSummary}`);
    }

    if (audit.violations.length > 0) {
      console.error(`\n[SECURITY FAIL] Found ${audit.violations.length} violation(s) — ABORTING!`);
      for (const v of audit.violations) {
        console.error(`  - ${v.file}${v.line ? `:${v.line}` : ''} [${v.rule}] ${v.label} -> ${v.preview}`);
      }
      process.exitCode = 1;
      return;
    }

    const execPaths = stageAndPreserveModes(tempDir, keptEntries);
    console.log(`Executable (+x) files preserved: ${execPaths.length} (${execPaths.join(', ') || 'none'})`);

    // Check whether staged tree differs from parent commit (for incremental pushes)
    let hasStagedDiff = true;
    if (opts.push && remoteHasBranch) {
      try {
        git(['diff', '--cached', '--quiet'], { cwd: tempDir });
        hasStagedDiff = false;
      } catch {
        hasStagedDiff = true;
      }
    }

    const commitMsg =
      opts.message ||
      (opts.tag
        ? `Release Kapsula ${opts.tag}`
        : remoteHasBranch
          ? `Sync Kapsula v${pkgVersion}`
          : `Kapsula v${pkgVersion}`);

    if (hasStagedDiff) {
      git(['commit', '-m', commitMsg], { cwd: tempDir });
      committedNewChanges = true;
    }
    publicCommitSha = git(['rev-parse', 'HEAD'], { cwd: tempDir }).trim();

    // Post-commit tree verification inside the clean repo
    const committedTree = listTreeEntries(tempDir, 'HEAD');
    const leakedInCommit = committedTree.filter((e) => classifyExclusion(e.path) !== null);
    if (leakedInCommit.length > 0) {
      throw new Error(
        `Post-commit verification failed: excluded path found in clean commit: ${leakedInCommit.map((e) => e.path).join(', ')}`,
      );
    }

    console.log(`Security violations: 0 (PASS)`);
    console.log(`Clean commit SHA:    ${publicCommitSha.slice(0, 12)}${committedNewChanges ? '' : ' (no tree diff)'}`);

    if (!opts.push) {
      console.log(`Result:              ${pushModeLabel} — ready for --push`);
      return;
    }

    if (committedNewChanges || !remoteHasBranch) {
      git(['push', 'origin', `HEAD:refs/heads/${opts.branch}`], { cwd: tempDir, env: authEnv });
    }
    pushModeLabel = remoteHasBranch
      ? committedNewChanges
        ? 'pushed incremental commit'
        : 'remote already up-to-date'
      : 'pushed initial clean orphan commit';

    if (opts.tag) {
      const existingTag = git(['ls-remote', '--tags', opts.remote, `refs/tags/${opts.tag}`], {
        cwd: tempDir,
        env: authEnv,
      }).trim();
      if (existingTag) {
        throw new Error(`Tag "${opts.tag}" already exists on remote ${opts.remote}.`);
      }
      git(['tag', '-a', opts.tag, '-m', `Kapsula ${opts.tag}`], { cwd: tempDir });
      git(['push', 'origin', `refs/tags/${opts.tag}`], { cwd: tempDir, env: authEnv });
      tagPushed = true;
    }

    console.log(`Result:              ${pushModeLabel}${tagPushed ? ` + pushed tag ${opts.tag}` : ''}`);
  } finally {
    if (opts.keepTemp) {
      console.log(`Kept temp directory: ${tempDir}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[publish-clean-github] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
