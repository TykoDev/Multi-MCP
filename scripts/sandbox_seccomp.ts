import { sandboxProfile, type SeccompProfile } from '@tykotech/sandbox';

// The vendored Docker profile is pinned by docker/seccomp-sandbox-source.json.
const base = JSON.parse(await Deno.readTextFile('docker/seccomp-sandbox-base.json')) as SeccompProfile;
await Deno.writeTextFile('docker/seccomp-sandbox.json', JSON.stringify(sandboxProfile(base), null, '\t') + '\n');
