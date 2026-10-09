/**
 * Review R3-5 (D-121): a task id no node has recorded — yet, because the record is written after the task exists,
 * or ever, because the write failed — is looked for rather than answered "not found" by whichever node the caller
 * happened to reach. This node answers when it holds the task; otherwise every other node is asked, and the first that
 * knows the task answers. The caller's own `Authorization` goes with each hop, so owner isolation is each node's own.
 */
import { assertEquals } from '@std/assert';
import { firstFound } from './routing.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** One node's `agent_get_task` answer: the task, or the tool error a runtime gives for an id it does not hold. */
function answer(id: number, taskId: string | null): string {
	if (taskId === null) {
		return JSON.stringify({
			jsonrpc: '2.0',
			id,
			result: { isError: true, content: [{ type: 'text', text: 'Error: not-found: Task not found' }] },
		});
	}
	const payload = { result: { task: { id: taskId, status: { state: 'TASK_STATE_WORKING' } } } };
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload },
	});
}

const call = JSON.stringify({
	jsonrpc: '2.0',
	id: 5,
	method: 'tools/call',
	params: { name: 'agent_get_task', arguments: { task_id: 'T-1' } },
});

Deno.test('R3-5: an unrecorded task is answered by the node that holds it, with the caller credential on the hop', async () => {
	const seen: string[] = [];
	const holder = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		seen.push(request.headers.get('authorization') ?? '');
		return new Response(answer(5, 'T-1'), { headers: JSON_HEADERS });
	});
	const stranger = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => new Response(answer(5, null), { headers: JSON_HEADERS }),
	);
	const at = (server: Deno.HttpServer) => `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
	const self = { id: 'a', url: 'http://127.0.0.1:8040', role: 'edge' as const, version: '0' };
	const nodes = [
		self,
		{ id: 'dead', url: 'http://127.0.0.1:1', role: 'browser' as const, version: '0' },
		{ id: 'c', url: at(stranger), role: 'browser' as const, version: '0' },
		{ id: 'b', url: at(holder), role: 'browser' as const, version: '0' },
	];
	const request = () =>
		new Request('http://127.0.0.1/mcp', { method: 'POST', body: call, headers: { authorization: 'Bearer k' } });
	try {
		let localCalls = 0;
		const found = await firstFound(nodes, request(), call, self, () => {
			localCalls++;
			return Promise.resolve(new Response(answer(5, null), { headers: JSON_HEADERS }));
		});
		assertEquals(found.status, 200);
		assertEquals(JSON.parse(await found.text()).result.structuredContent.result.task.id, 'T-1');
		assertEquals(localCalls, 1, 'this node is asked first, once');
		assertEquals(seen, ['Bearer k'], 'the holder was asked with the caller credential');

		// This node holds it: nobody else is asked.
		const local = await firstFound(
			nodes,
			request(),
			call,
			self,
			() => Promise.resolve(new Response(answer(5, 'T-1'), { headers: JSON_HEADERS })),
		);
		assertEquals(JSON.parse(await local.text()).result.structuredContent.result.task.id, 'T-1');
		assertEquals(seen.length, 1);

		// Nobody holds it: the local "not found", body intact.
		const none = await firstFound(
			[self, nodes[1]!, nodes[2]!],
			request(),
			call,
			self,
			() => Promise.resolve(new Response(answer(5, null), { headers: JSON_HEADERS })),
		);
		assertEquals(await none.text(), answer(5, null));
	} finally {
		await holder.shutdown();
		await stranger.shutdown();
	}
});
