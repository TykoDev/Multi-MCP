/** Exact executable grants for the ACP test tier, recorded by D-066. */
console.log([Deno.execPath(), ...(Deno.build.os === 'linux' ? ['/usr/bin/setsid', '/usr/bin/kill'] : [])].join(','));
