/**
 * ERRATUM(E-82): `scripts/compile.ts` no longer bakes a Linux Chromium path into a binary for another OS.
 *
 * The decision is a pure function of the target, the host and an explicit `--chromium`, with discovery injected, so
 * every branch is checked here in the unit tier; the compile tier (`deno task test:compile`) then runs the real thing
 * on each CI host.
 */
import { assertEquals, assertRejects } from '@std/assert';
import { chromiumFor, LINUX_CHROMIUM, targetOs } from '../../scripts/compile.ts';

const found = (path: string) => () => Promise.resolve(path);
const none = () => Promise.reject(new Error('no browser found\nsearched: …'));

Deno.test('E-82: a target maps to its operating system, and the host stands in for no target', () => {
	assertEquals(targetOs('x86_64-unknown-linux-gnu'), 'linux');
	assertEquals(targetOs('aarch64-unknown-linux-gnu'), 'linux');
	assertEquals(targetOs('x86_64-pc-windows-msvc'), 'windows');
	assertEquals(targetOs('aarch64-apple-darwin'), 'darwin');
	assertEquals(targetOs(null, 'windows'), 'windows');
	assertEquals(targetOs(null, 'darwin'), 'darwin');
	assertEquals(targetOs(null, 'linux'), 'linux');
	assertEquals(targetOs(null, 'freebsd'), 'linux', 'anything else compiles as the Linux shape');
});

Deno.test('E-82: an explicit --chromium always wins, whatever the target and host', async () => {
	assertEquals(
		await chromiumFor('x86_64-pc-windows-msvc', 'C:/Chrome/chrome.exe', none, 'linux'),
		'C:/Chrome/chrome.exe',
	);
	assertEquals(await chromiumFor(null, '/opt/chromium', none, 'windows'), '/opt/chromium');
});

Deno.test('E-82: a Linux target keeps the images\u2019 /usr/bin/chromium, from any host', async () => {
	assertEquals(await chromiumFor(null, undefined, none, 'linux'), LINUX_CHROMIUM);
	assertEquals(await chromiumFor('aarch64-unknown-linux-gnu', undefined, none, 'windows'), LINUX_CHROMIUM);
});

Deno.test('E-82: a host-OS target bakes what this host discovers, never the Linux path', async () => {
	const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
	assertEquals(await chromiumFor(null, undefined, found(chrome), 'windows'), chrome);
	assertEquals(await chromiumFor('x86_64-pc-windows-msvc', undefined, found(chrome), 'windows'), chrome);
	const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
	assertEquals(await chromiumFor('aarch64-apple-darwin', undefined, found(mac), 'darwin'), mac);
});

Deno.test('E-82: nothing to discover, or a foreign non-Linux target, fails with the flag to pass', async () => {
	await assertRejects(() => chromiumFor(null, undefined, none, 'windows'), Error, '--chromium <absolute path>');
	await assertRejects(
		() => chromiumFor('x86_64-pc-windows-msvc', undefined, found('/usr/bin/chromium'), 'linux'),
		Error,
		'pass --chromium',
	);
	await assertRejects(() => chromiumFor('x86_64-apple-darwin', undefined, none, 'windows'), Error, 'a darwin target');
});
