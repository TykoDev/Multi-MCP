/**
 * Test support for R12 (design §2.19, M8): a throwaway certificate authority and one server certificate it signs,
 * built in memory with WebCrypto (ECDSA P-256) and a few lines of DER, so a test can run a TLS upstream on loopback
 * that a client trusts only through `caCerts` — no openssl, no file, no network. Every key lives as long as the test.
 *
 * Also a reader for the server name (SNI) a TLS ClientHello carries, so a test relay in front of that upstream can
 * prove which name the client asked for.
 *
 * Not exported from mod.ts; only the package's tests (and the sandbox tier) import it.
 */
const encoder = new TextEncoder();

function lengthOf(size: number): number[] {
	if (size < 0x80) return [size];
	const bytes: number[] = [];
	for (let value = size; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

/** One DER element: its tag, its length, and its parts joined. */
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const size = parts.reduce((total, part) => total + part.length, 0);
	const head = [tag, ...lengthOf(size)];
	const out = new Uint8Array(head.length + size);
	out.set(head);
	let at = head.length;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const sequence = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]): Uint8Array => tlv(0x31, ...parts);
const TRUE = tlv(0x01, Uint8Array.of(0xff));

function integer(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const value = bytes.subarray(start);
	return tlv(0x02, (value[0]! & 0x80) === 0 ? value : Uint8Array.of(0, ...value));
}

function oid(text: string): Uint8Array {
	const [first, second, ...rest] = text.split('.').map(Number);
	const out = [40 * first! + second!];
	for (const arc of rest) {
		const chunk = [arc & 0x7f];
		for (let value = arc >>> 7; value > 0; value >>>= 7) chunk.unshift((value & 0x7f) | 0x80);
		out.push(...chunk);
	}
	return tlv(0x06, Uint8Array.from(out));
}

function utcTime(date: Date): Uint8Array {
	const two = (n: number) => String(n).padStart(2, '0');
	return tlv(
		0x17,
		encoder.encode(
			`${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
				`${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
		),
	);
}

const bitString = (bytes: Uint8Array, unused = 0): Uint8Array => tlv(0x03, Uint8Array.of(unused), bytes);
const name = (commonName: string): Uint8Array =>
	sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, encoder.encode(commonName)))));
const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array =>
	critical ? sequence(oid(id), TRUE, tlv(0x04, value)) : sequence(oid(id), tlv(0x04, value));
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

function pem(label: string, der: Uint8Array): string {
	let binary = '';
	for (const byte of der) binary += String.fromCharCode(byte);
	const lines = btoa(binary).match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const P256: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

async function certificate(input: {
	subject: string;
	issuer: string;
	publicKey: CryptoKey;
	signer: CryptoKey;
	ca: boolean;
	dnsNames?: readonly string[];
}): Promise<Uint8Array> {
	const spki = new Uint8Array(await crypto.subtle.exportKey('spki', input.publicKey));
	const serial = crypto.getRandomValues(new Uint8Array(16));
	serial[0] = (serial[0]! & 0x7f) | 0x01;
	const now = Date.now();
	const extensions = [
		// basicConstraints: a CA, or an end entity.
		extension('2.5.29.19', true, input.ca ? sequence(TRUE) : sequence()),
		// keyUsage: keyCertSign + cRLSign for the CA, digitalSignature for the server.
		extension('2.5.29.15', true, input.ca ? bitString(Uint8Array.of(0x06), 1) : bitString(Uint8Array.of(0x80), 7)),
	];
	if (input.dnsNames !== undefined) {
		extensions.push(
			extension('2.5.29.17', false, sequence(...input.dnsNames.map((dns) => tlv(0x82, encoder.encode(dns))))),
			extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
		);
	}
	const tbs = sequence(
		tlv(0xa0, integer(Uint8Array.of(2))),
		integer(serial),
		ECDSA_SHA256,
		name(input.issuer),
		sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
		name(input.subject),
		spki,
		tlv(0xa3, sequence(...extensions)),
	);
	// WebCrypto signs as r || s; X.509 wants the DER sequence of the two integers.
	const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, input.signer, tbs));
	const half = raw.length / 2;
	return sequence(tbs, ECDSA_SHA256, bitString(sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)))));
}

/** A CA certificate, and a server certificate and key for `dnsNames`, all PEM. */
export interface TestPki {
	caCert: string;
	cert: string;
	key: string;
}

/** Makes a fresh CA and a server certificate it signs for `dnsNames` (valid from an hour ago for a day). */
export async function testPki(dnsNames: readonly string[]): Promise<TestPki> {
	const ca = await crypto.subtle.generateKey(P256, true, ['sign', 'verify']);
	const server = await crypto.subtle.generateKey(P256, true, ['sign', 'verify']);
	const caName = `ttk test ca ${crypto.randomUUID().slice(0, 8)}`;
	const caCert = await certificate({
		subject: caName,
		issuer: caName,
		publicKey: ca.publicKey,
		signer: ca.privateKey,
		ca: true,
	});
	const cert = await certificate({
		subject: dnsNames[0] ?? 'server',
		issuer: caName,
		publicKey: server.publicKey,
		signer: ca.privateKey,
		ca: false,
		dnsNames,
	});
	const key = new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey));
	return { caCert: pem('CERTIFICATE', caCert), cert: pem('CERTIFICATE', cert), key: pem('PRIVATE KEY', key) };
}

/**
 * The server name a TLS ClientHello asks for (its `server_name` extension), or null when `bytes` hold a complete
 * ClientHello without one; `undefined` while more bytes are needed.
 */
export function clientHelloServerName(bytes: Uint8Array): string | null | undefined {
	if (bytes.length < 5) return undefined;
	if (bytes[0] !== 0x16) return null;
	const recordLength = (bytes[3]! << 8) | bytes[4]!;
	if (bytes.length < 5 + recordLength) return undefined;
	const hello = bytes.subarray(5, 5 + recordLength);
	if (hello[0] !== 0x01) return null;
	let at = 4 + 2 + 32; // handshake header, version, random
	at += 1 + hello[at]!; // session id
	at += 2 + ((hello[at]! << 8) | hello[at + 1]!); // cipher suites
	at += 1 + hello[at]!; // compression methods
	const end = at + 2 + ((hello[at]! << 8) | hello[at + 1]!);
	at += 2;
	while (at + 4 <= end) {
		const type = (hello[at]! << 8) | hello[at + 1]!;
		const size = (hello[at + 2]! << 8) | hello[at + 3]!;
		const data = hello.subarray(at + 4, at + 4 + size);
		if (type === 0) {
			// server_name_list: list length (2), then name type (1, 0 = host_name), name length (2), name.
			const nameLength = (data[3]! << 8) | data[4]!;
			return new TextDecoder().decode(data.subarray(5, 5 + nameLength));
		}
		at += 4 + size;
	}
	return null;
}
