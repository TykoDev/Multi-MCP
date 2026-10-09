/**
 * Tier-1 containment suite (OBSERVABILITY-TESTING-CICD.md §4.2 `fs-containment`; SECURITY-AUTH.md
 * §8). Pure and hermetic: no filesystem access, no `--allow-write`, both path flavours exercised on
 * whichever OS the runner happens to be.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import {
	containedJoin,
	currentPathFlavor,
	DEFAULT_UNIQUE_ATTEMPTS,
	isContainedIn,
	MAX_FILENAME_LENGTH,
	type PathFlavor,
	pathFlavorFor,
	RESERVED_DEVICE_NAMES,
	resolveDownloadPath,
	sanitizeFilename,
	uniqueFilename,
} from './containment.ts';

// ---------------------------------------------------------------------------
// filename sanitisation (§8.3)
// ---------------------------------------------------------------------------

type NameCase = { readonly name: string; readonly input: string; readonly expected: string | null };

Deno.test.each<NameCase>([
	{ name: 'ordinary name survives', input: 'quarterly report.pdf', expected: 'quarterly report.pdf' },
	{ name: 'dotfile survives', input: '.bashrc', expected: '.bashrc' },
	{ name: 'posix traversal', input: '../../etc/passwd', expected: 'passwd' },
	{ name: 'windows traversal', input: '..\\..\\Windows\\System32\\evil.dll', expected: 'evil.dll' },
	{ name: 'absolute posix path', input: '/etc/shadow', expected: 'shadow' },
	{ name: 'absolute windows path', input: 'C:\\Windows\\evil.exe', expected: 'evil.exe' },
	{ name: 'drive-relative name', input: 'C:evil.txt', expected: 'C_evil.txt' },
	{ name: 'NTFS alternate data stream', input: 'report.pdf:payload.exe', expected: 'report.pdf_payload.exe' },
	{ name: 'bare ADS', input: ':$DATA', expected: '_$DATA' },
	{ name: 'embedded NUL', input: 'file\u0000.txt', expected: 'file.txt' },
	{ name: 'newline and tab', input: 'a\nb\tc.txt', expected: 'abc.txt' },
	{ name: 'RTL override extension spoof', input: 'evil\u202Egnp.exe', expected: 'evilgnp.exe' },
	{ name: 'fullwidth solidus', input: 'a\uFF0Fb\uFF0Fevil.txt', expected: 'evil.txt' },
	{ name: 'fullwidth reverse solidus', input: '\uFF3Cetc\uFF3Cevil.txt', expected: 'evil.txt' },
	{ name: 'division slash', input: 'a\u2215b.txt', expected: 'b.txt' },
	{ name: 'fraction slash', input: 'a\u2044b.txt', expected: 'b.txt' },
	{ name: 'set-minus slash', input: 'a\u2216b.txt', expected: 'b.txt' },
	{ name: 'big reverse solidus', input: 'a\u29F5b.txt', expected: 'b.txt' },
	{ name: 'small reverse solidus', input: 'a\uFE68b.txt', expected: 'b.txt' },
	{ name: 'percent-escaped traversal stays a flat name', input: '%2e%2e%2fpasswd', expected: '%2e%2e%2fpasswd' },
	{ name: 'trailing dot (windows would drop it)', input: 'evil.exe.', expected: 'evil.exe' },
	{ name: 'trailing space (windows would drop it)', input: 'evil.exe ', expected: 'evil.exe' },
	{ name: 'leading whitespace', input: '   spaced.txt', expected: 'spaced.txt' },
	{ name: 'dot', input: '.', expected: null },
	{ name: 'dot-dot', input: '..', expected: null },
	{ name: 'ellipsis', input: '...', expected: null },
	{ name: 'empty', input: '', expected: null },
	{ name: 'whitespace only', input: '   ', expected: null },
	{ name: 'directory only', input: '../../', expected: null },
	{ name: 'reserved device name', input: 'CON', expected: '_CON' },
	{ name: 'reserved device name with extension', input: 'nul.txt', expected: '_nul.txt' },
	{ name: 'reserved printer port', input: 'LPT9.log', expected: '_LPT9.log' },
	{ name: 'device-name prefix is not reserved', input: 'contract.pdf', expected: 'contract.pdf' },
])('sanitize: $name', (row) => {
	assertEquals(sanitizeFilename(row.input), row.expected);
});

Deno.test('sanitize: over-long names are truncated, extension preserved', () => {
	const withExtension = sanitizeFilename(`${'x'.repeat(300)}.pdf`);
	assertEquals(withExtension?.length, MAX_FILENAME_LENGTH);
	assert(withExtension?.endsWith('.pdf'));

	const withoutExtension = sanitizeFilename('y'.repeat(300));
	assertEquals(withoutExtension?.length, MAX_FILENAME_LENGTH);

	// A 30-char "extension" is not one; it gets truncated like any other text.
	const fakeExtension = sanitizeFilename(`${'z'.repeat(300)}.${'e'.repeat(30)}`);
	assertEquals(fakeExtension?.length, MAX_FILENAME_LENGTH);
	assertFalse(fakeExtension?.includes('.'));
});

Deno.test('sanitize: no output can escape a directory when joined', () => {
	const hostile = [
		'../../etc/passwd',
		'..\\..\\evil.dll',
		'/etc/shadow',
		'C:\\Windows\\evil.exe',
		'a\uFF0F..\uFF0Fb.txt',
		'report.pdf:payload.exe',
	];
	for (const flavor of ['posix', 'windows'] as const) {
		const base = flavor === 'windows' ? 'C:\\downloads' : '/downloads';
		for (const name of hostile) {
			const joined = containedJoin(base, name, flavor);
			assert(joined !== null, name);
			assert(isContainedIn(base, joined, flavor), `${name} escaped as ${joined}`);
		}
	}
});

Deno.test('sanitize: the reserved-name table is the 22 Windows device names', () => {
	assertEquals(RESERVED_DEVICE_NAMES.size, 22);
	for (const name of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
		assert(RESERVED_DEVICE_NAMES.has(name));
	}
});

// ---------------------------------------------------------------------------
// ` (n)` disambiguation (§8.3)
// ---------------------------------------------------------------------------

Deno.test('unique: a free name is returned unchanged', () => {
	assertEquals(uniqueFilename('report.pdf', () => false), 'report.pdf');
	assertEquals(DEFAULT_UNIQUE_ATTEMPTS, 1000);
});

Deno.test('unique: collisions get " (n)" before the extension', () => {
	const existing = new Set(['report.pdf', 'report (1).pdf']);
	assertEquals(uniqueFilename('report.pdf', (name) => existing.has(name)), 'report (2).pdf');
});

Deno.test('unique: extensionless names and dotfiles keep their whole name as the stem', () => {
	assertEquals(uniqueFilename('README', (name) => name === 'README'), 'README (1)');
	assertEquals(uniqueFilename('.bashrc', (name) => name === '.bashrc'), '.bashrc (1)');
});

Deno.test('unique: an exhausted budget refuses rather than overwriting', () => {
	assertEquals(uniqueFilename('report.pdf', () => true, 3), null);
});

// ---------------------------------------------------------------------------
// directory containment (§8.2/§8.3, and profile-dir containment per §3.3)
// ---------------------------------------------------------------------------

type ContainCase = {
	readonly name: string;
	readonly flavor: PathFlavor;
	readonly base: string;
	readonly candidate: string;
	readonly expected: boolean;
};

Deno.test.each<ContainCase>([
	{ name: 'posix child', flavor: 'posix', base: '/downloads', candidate: '/downloads/f.txt', expected: true },
	{ name: 'posix grandchild', flavor: 'posix', base: '/downloads', candidate: '/downloads/a/b/f.txt', expected: true },
	{ name: 'posix self', flavor: 'posix', base: '/downloads', candidate: '/downloads', expected: true },
	{
		name: 'posix base with trailing slash',
		flavor: 'posix',
		base: '/downloads/',
		candidate: '/downloads/f.txt',
		expected: true,
	},
	{ name: 'posix root as base', flavor: 'posix', base: '/', candidate: '/etc/passwd', expected: true },
	{
		name: 'posix sibling with a shared prefix',
		flavor: 'posix',
		base: '/downloads',
		candidate: '/downloads2/f.txt',
		expected: false,
	},
	{
		name: 'posix traversal out',
		flavor: 'posix',
		base: '/downloads',
		candidate: '/downloads/../etc/passwd',
		expected: false,
	},
	{
		name: 'posix is case-sensitive',
		flavor: 'posix',
		base: '/Downloads',
		candidate: '/downloads/f.txt',
		expected: false,
	},
	{
		name: 'posix parent is not contained',
		flavor: 'posix',
		base: '/downloads/sub',
		candidate: '/downloads',
		expected: false,
	},
	{
		name: 'relative base is refused',
		flavor: 'posix',
		base: 'downloads',
		candidate: '/downloads/f.txt',
		expected: false,
	},
	{ name: 'relative candidate is refused', flavor: 'posix', base: '/downloads', candidate: 'f.txt', expected: false },
	{ name: 'windows child', flavor: 'windows', base: 'C:\\dl', candidate: 'C:\\dl\\f.txt', expected: true },
	{
		name: 'windows is case-insensitive',
		flavor: 'windows',
		base: 'C:\\DL',
		candidate: 'c:\\dl\\F.TXT',
		expected: true,
	},
	{ name: 'windows mixed separators', flavor: 'windows', base: 'C:\\dl', candidate: 'C:/dl/f.txt', expected: true },
	{
		name: 'windows sibling with a shared prefix',
		flavor: 'windows',
		base: 'C:\\dl',
		candidate: 'C:\\dltwo\\f.txt',
		expected: false,
	},
	{ name: 'windows other drive', flavor: 'windows', base: 'C:\\dl', candidate: 'D:\\dl\\f.txt', expected: false },
	{
		name: 'windows traversal out',
		flavor: 'windows',
		base: 'C:\\dl',
		candidate: 'C:\\dl\\..\\evil.exe',
		expected: false,
	},
	{
		name: 'windows UNC child',
		flavor: 'windows',
		base: '\\\\srv\\share',
		candidate: '\\\\srv\\share\\f.txt',
		expected: true,
	},
	{
		name: 'windows base with trailing separator',
		flavor: 'windows',
		base: 'C:\\dl\\',
		candidate: 'C:\\dl\\f.txt',
		expected: true,
	},
])('contain: $name', (row) => {
	assertEquals(isContainedIn(row.base, row.candidate, row.flavor), row.expected);
});

Deno.test('contain: the flavour defaults to the running platform', () => {
	assertEquals(pathFlavorFor('windows'), 'windows');
	assertEquals(pathFlavorFor('linux'), 'posix');
	assertEquals(pathFlavorFor('darwin'), 'posix');
	const flavor = currentPathFlavor();
	assertEquals(flavor, pathFlavorFor(Deno.build.os));
	const base = flavor === 'windows' ? 'C:\\dl' : '/dl';
	const child = flavor === 'windows' ? 'C:\\dl\\f.txt' : '/dl/f.txt';
	assert(isContainedIn(base, child));
	assertFalse(isContainedIn(base, flavor === 'windows' ? 'C:\\other\\f.txt' : '/other/f.txt'));
});

Deno.test('contain: profile-dir containment uses the same predicate', () => {
	// A storage-state file must live inside the user-data-dir; a `..` escape must not.
	assert(isContainedIn('/profiles/session-1', '/profiles/session-1/Default/Cookies', 'posix'));
	assertFalse(isContainedIn('/profiles/session-1', '/profiles/session-1/../session-2/Cookies', 'posix'));
});

Deno.test('containedJoin: sanitises, joins, and refuses what it cannot place', () => {
	assertEquals(containedJoin('/dl', '../../etc/passwd', 'posix'), '/dl/passwd');
	assertEquals(containedJoin('C:\\dl', '..\\evil.exe', 'windows'), 'C:\\dl\\evil.exe');
	assertEquals(containedJoin('/dl', '..', 'posix'), null);
	// A relative base cannot be proven contained, so nothing is placed in it.
	assertEquals(containedJoin('dl', 'f.txt', 'posix'), null);
});

// ---------------------------------------------------------------------------
// the DownloadsWatchdog seam
// ---------------------------------------------------------------------------

Deno.test('download: sanitise → disambiguate → contain, in one call', () => {
	const existing = new Set(['/dl/passwd']);
	const target = resolveDownloadPath('/dl', '../../etc/passwd', (path) => existing.has(path), { flavor: 'posix' });
	assertEquals(target, { name: 'passwd (1)', path: '/dl/passwd (1)' });
});

Deno.test('download: a fresh name lands directly in the downloads dir', () => {
	const target = resolveDownloadPath('C:\\dl', 'report.pdf', () => false, { flavor: 'windows' });
	assertEquals(target, { name: 'report.pdf', path: 'C:\\dl\\report.pdf' });
});

Deno.test('download: unusable names and exhausted budgets are refused, never guessed', () => {
	assertEquals(resolveDownloadPath('/dl', '..', () => false, { flavor: 'posix' }), null);
	assertEquals(resolveDownloadPath('/dl', 'x.bin', () => true, { flavor: 'posix', maxAttempts: 2 }), null);
	// A relative downloads dir fails the containment check rather than writing to the cwd.
	assertEquals(resolveDownloadPath('dl', 'x.bin', () => false, { flavor: 'posix' }), null);
});

Deno.test('download: the flavour and attempt budget default when omitted', () => {
	const flavor = currentPathFlavor();
	const base = flavor === 'windows' ? 'C:\\dl' : '/dl';
	const target = resolveDownloadPath(base, 'a.txt', () => false);
	assert(target !== null);
	assert(isContainedIn(base, target.path));
});
