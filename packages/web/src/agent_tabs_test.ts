/// <reference lib="deno.ns" />
import { assertEquals } from '@std/assert';
import { agentRoute, chatRoute, tasksRoute } from './agent_tabs.ts';
import { parseWorkspaceParam, workspaceRoute } from './workspaces_view.ts';

const WS = '2276732b-a79d-436f-9cea-1a80b68a06b2';

Deno.test('agent routes: chat and tasks, a task id, and the Tasks view’s workspace filter', () => {
	assertEquals(agentRoute('#/agents'), { tab: 'chat', taskId: null, workspace: null });
	assertEquals(agentRoute('#/agents/chat/t%201'), { tab: 'chat', taskId: 't 1', workspace: null });
	assertEquals(agentRoute('#/agents/tasks'), { tab: 'tasks', taskId: null, workspace: null });
	assertEquals(agentRoute(`#/agents/tasks?workspace=${WS}`), { tab: 'tasks', taskId: null, workspace: WS });
	assertEquals(agentRoute(`#/agents/tasks/abc?workspace=${WS}`), { tab: 'tasks', taskId: 'abc', workspace: WS });
	// A malformed filter is ignored, not trusted; the chat never filters.
	assertEquals(agentRoute('#/agents/tasks?workspace=../x')?.workspace, null);
	assertEquals(agentRoute(`#/agents/chat/abc?workspace=${WS}`)?.workspace, null);
	assertEquals(agentRoute('#/agents/elsewhere'), null);
	assertEquals(agentRoute('#/agents/tasks/%E0%A4%A'), null);
	// The builders write what the parser reads.
	assertEquals(agentRoute(tasksRoute('a b', WS)), { tab: 'tasks', taskId: 'a b', workspace: WS });
	assertEquals(tasksRoute(null), '#/agents/tasks');
	assertEquals(chatRoute(null), '#/agents');
});

Deno.test('workspace routes: files by default, surfaces by name', () => {
	assertEquals(parseWorkspaceParam(undefined), { id: undefined, view: 'files' });
	assertEquals(parseWorkspaceParam(WS), { id: WS, view: 'files' });
	assertEquals(parseWorkspaceParam(`${WS}/surfaces`), { id: WS, view: 'surfaces' });
	assertEquals(parseWorkspaceParam(`${WS}/other`), { id: WS, view: 'files' });
	assertEquals(workspaceRoute(WS, 'surfaces'), `#/workspaces/${WS}/surfaces`);
	assertEquals(workspaceRoute(WS, 'files'), `#/workspaces/${WS}`);
});
