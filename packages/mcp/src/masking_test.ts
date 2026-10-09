/**
 * The `browser_type` masking heuristic (§2.3). The asymmetry is deliberate and is what the tests
 * pin: over-masking costs the model a little context, under-masking costs a credential, so the
 * false-positive cases below are documented as acceptable rather than treated as bugs.
 */

import { assertEquals } from '@std/assert';
import { classifySensitiveText, CREDENTIAL_MIN_LENGTH, SENSITIVE_MIN_LENGTH } from './masking.ts';

Deno.test('masking: §2.3 thresholds', () => {
	assertEquals(SENSITIVE_MIN_LENGTH, 6);
	assertEquals(CREDENTIAL_MIN_LENGTH, 16);
});

Deno.test('masking: short text is never sensitive, whatever it looks like', () => {
	for (const text of ['', 'a', 'pw', 'a@b.c']) {
		assertEquals(classifySensitiveText(text).sensitive, false, text);
	}
});

Deno.test('masking: email-shaped text masks as <email> from 6 characters up', () => {
	const result = classifySensitiveText('ab@c.de');
	assertEquals(result, { sensitive: true, kind: 'email', display: '<email>' });
	assertEquals(classifySensitiveText('someone@example.test').display, '<email>');
});

Deno.test('masking: 16+ alphanumeric-plus-.-_ masks as <credential>', () => {
	assertEquals(classifySensitiveText('hunter2hunter2hunter').kind, 'credential');
	assertEquals(classifySensitiveText('sk-live_AbCd.1234-XY').display, '<credential>');
	// Exactly at the boundary.
	assertEquals(classifySensitiveText('a'.repeat(16)).kind, 'credential');
	assertEquals(classifySensitiveText('a'.repeat(15)).sensitive, false);
});

Deno.test('masking: long prose is not a credential — the character class excludes spaces', () => {
	const prose = 'the quick brown fox jumps over the lazy dog';
	assertEquals(classifySensitiveText(prose).sensitive, false);
	assertEquals(classifySensitiveText(prose).display, prose);
});

Deno.test('masking: text with punctuation outside .-_ is not a credential', () => {
	assertEquals(classifySensitiveText('search: widgets & gizmos!').sensitive, false);
});

Deno.test('masking: a long opaque identifier is masked — the accepted false positive of §2.3', () => {
	// A SKU or order id trips the credential branch. Documented, and the safe direction to be wrong.
	assertEquals(classifySensitiveText('ORDER-2026-000123456').kind, 'credential');
});

Deno.test('masking: the raw value never appears in the display string', () => {
	for (const text of ['someone@example.test', 'p4ssw0rd-with-length-16']) {
		const result = classifySensitiveText(text);
		assertEquals(result.sensitive, true);
		assertEquals(result.display.includes(text), false);
	}
});
