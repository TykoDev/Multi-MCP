/**
 * R12 (design §2.19, AC34): one git smart-HTTP exchange (protocol v0, stateless RPC) for a shallow clone of a tiny,
 * deterministic two-commit repository, recorded once from `git http-backend` on loopback and replayed by the sandbox
 * tier's fake upstream, so a real `git clone` in a cage can run through the credentialed forwarder end to end with
 * no git or network on the upstream side. Synthetic content only.
 *
 * The repository: commit `87cd3de5` "first" (README.md "first"), then `80445e2e` "second" (README.md
 * "hello from the clone fixture", src/main.py "print(42)"), author and committer "Fixture <fixture@example.test>",
 * dated 2026-01-01 and 2026-01-02 UTC, on `main`. A depth-1 clone gets the second commit, marked shallow.
 */

/** The commit a depth-1 clone of `main` lands on. */
export const FIXTURE_COMMIT = '80445e2e21d609fd261502c216b1847b40923c7d';
/** What the clone's README.md holds. */
export const FIXTURE_README = 'hello from the clone fixture\n';

function bytes(parts: string[]): Uint8Array {
	const binary = atob(parts.join(''));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** `GET <repo>/info/refs?service=git-upload-pack`: the v0 ref advertisement. */
export const ADVERTISEMENT = bytes([
	'MDAxZSMgc2VydmljZT1naXQtdXBsb2FkLXBhY2sKMDAwMDAxMWQ4MDQ0NWUyZTIxZDYwOWZkMjYxNTAyYzIxNmIxODQ3YjQwOTIz',
	'YzdkIEhFQUQAbXVsdGlfYWNrIHRoaW4tcGFjayBzaWRlLWJhbmQgc2lkZS1iYW5kLTY0ayBvZnMtZGVsdGEgc2hhbGxvdyBkZWVw',
	'ZW4tc2luY2UgZGVlcGVuLW5vdCBkZWVwZW4tcmVsYXRpdmUgbm8tcHJvZ3Jlc3MgaW5jbHVkZS10YWcgbXVsdGlfYWNrX2RldGFp',
	'bGVkIG5vLWRvbmUgc3ltcmVmPUhFQUQ6cmVmcy9oZWFkcy9tYWluIG9iamVjdC1mb3JtYXQ9c2hhMSBhZ2VudD1naXQvMi41NC4w',
	'LndpbmRvd3MuMS1XaW5kb3dzCjAwM2Q4MDQ0NWUyZTIxZDYwOWZkMjYxNTAyYzIxNmIxODQ3YjQwOTIzYzdkIHJlZnMvaGVhZHMv',
	'bWFpbgowMDAw',
]);

/** The first `POST <repo>/git-upload-pack` (wants and `deepen 1`, no `done`): the shallow list alone. */
export const SHALLOW_REPLY = bytes([
	'MDAzNHNoYWxsb3cgODA0NDVlMmUyMWQ2MDlmZDI2MTUwMmMyMTZiMTg0N2I0MDkyM2M3ZDAwMDA=',
]);

/** The second `POST <repo>/git-upload-pack` (ending `done`): the shallow list, NAK and the pack, side-band. */
export const PACK_REPLY = bytes([
	'MDAzNHNoYWxsb3cgODA0NDVlMmUyMWQ2MDlmZDI2MTUwMmMyMTZiMTg0N2I0MDkyM2M3ZDAwMDAwMDA4TkFLCjAxNmUBUEFDSwAA',
	'AAIAAAAFlw14nJXLSQoCMRBA0X1Okb0gqSSVSkDElffIUMEGeyBdDX18BU/g5vM2XwazTjkEk3wJXIESIhRKMfmG0GNAa12FYlxA',
	'teXBi+hItbnG6DtUT8ZSA+8plA6R2GWMibqr7FU+5LUO/ZxOOQbrW//hwWeetzdfhXe5a6BADqwxRl++Maqu8zyJ8P+n2rmuS1Mf',
	'h4NAJKMEeJwzNDAwMzFRCHJ1dPF11ctNYXg21Xf17ePNNX++aScFcmju2m55l9/EAAgUiouSGQp27DnKLK7WPO1U9ts3t1j3ntY+',
	'bQYAT5Mbp70BeJzLSM3JyVdIK8rPVSjJSFVIzsnPS1VIy6woKS1K5QIAomAKrKMCeJwzNDAwMzFRyE3MzNMrqGQIrHa/H3woZQNj',
	'pvY/hrVnVLYf3FIIANERDfQ6eJwrKMrMK9EwMdLkAgAT+ALvrn3gGCxypqYykssyfcsNNNbFmjAwMDYBejAwMDA=',
]);
