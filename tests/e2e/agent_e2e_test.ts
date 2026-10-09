/**
 * R1 (`browser_extract_content`) and R2 (`browser_run_task`) end to end.
 *
 * The browser is real, the MCP round trips are real, and the client really
 * implements the sampling capability — which in MCP is where the model lives.
 * The responders read the page they are given, so an assertion that passes has
 * proven the observation pipeline delivered real page content to a real model
 * client and that the answer came back through the multi-round-trip protocol.
 *
 * When a real model is configured — a local OpenAI-compatible endpoint or an
 * Anthropic key, see `scripts/model_endpoint.ts` — the last suite runs the same
 * flows against it over the same prompts.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser } from '../support/harness.ts';
import {
	agentResponder,
	babblingResponder,
	extractionResponder,
	hasRealModel,
	realModelDescription,
	realModelResponder,
	realModels,
} from '../support/sampling.ts';

const ignore = skipUnlessBrowser('agent e2e');

interface ExtractResult {
	session_id: string;
	query: string;
	result: string;
	model: string;
}

interface TaskResult {
	session_id: string;
	status: 'done' | 'budget-exhausted';
	task: string;
	steps: number;
	history: string[];
	answer: string | null;
	model: string;
	resumable?: boolean;
}

Deno.test({
	name: 'e2e R1: extraction answers from the page the browser actually loaded',
	ignore,
	async fn(t) {
		await using h = await harness({ sampling: extractionResponder() });
		await h.callText('browser_navigate', { url: h.site.page('article') });

		await t.step('a question is answered from the live page', async () => {
			const result = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'What was the revenue?',
			});
			// The figure exists only in the fixture page, so the whole chain ran:
			// Chromium → DOM pipeline → prompt → the client's model → back.
			assertStringIncludes(result.result, '42 million euro');
			assertEquals(result.query, 'What was the revenue?');
			assertEquals(result.model, 'fixture-responder');
		});

		await t.step('a second question sees the same page', async () => {
			const result = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'Who is the chief executive?',
			});
			assertEquals(result.result, 'Dana Whitfield');
		});

		await t.step('the answer tracks the page, not the first call', async () => {
			// The nonce is regenerated per run and appears only on this page.
			const result = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'What is the run nonce?',
			});
			assertEquals(result.result, h.site.nonce);

			// Navigate away: the same question can no longer be answered, which
			// proves the prompt is rebuilt from the current document each time.
			await h.callText('browser_navigate', { url: h.site.page('second') });
			const after = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'What is the run nonce?',
			});
			assertStringIncludes(after.result, 'NOT-FOUND');
		});

		await t.step('extraction is read-only, so it survives a human takeover', async () => {
			await h.callText('browser_navigate', { url: h.site.page('article') });
			const socket = await h.live();
			const meta = await socket.ready();
			socket.send({ type: 'control.take' });
			await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);

			const result = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'How many employees?',
			});
			assertEquals(result.result, '1280');
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e R1: a client with no model is told so, not left hanging',
	ignore,
	async fn() {
		// No `sampling` responder, so the client declares no sampling capability.
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('article') });
		const error = await h.callError('browser_extract_content', { query: 'anything' });
		assertStringIncludes(error, 'sampling');
		// And it names the alternative that does work without a model.
		assertStringIncludes(error, 'browser_get_state');
	},
});

Deno.test({
	name: 'e2e R2: the task loop drives the real browser to completion',
	ignore,
	async fn(t) {
		await using h = await harness({ sampling: agentResponder(), maxRounds: 20 });

		await t.step('a click task completes and reports what it observed', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const result = await h.callJson<TaskResult>('browser_run_task', {
				task: 'Press the button and report the text the page then shows.',
				max_steps: 5,
			});
			assertEquals(result.status, 'done');
			// The answer carries this run's nonce, which only the real page had.
			assertEquals(result.answer, `clicked-${h.site.nonce}`);
			// And the browser really was clicked.
			assertStringIncludes(await h.callText('browser_get_html', {}), `clicked-${h.site.nonce}`);
			assert(result.steps >= 2, `expected at least a click and a done, got ${result.steps}`);
			assertStringIncludes(result.history.join('\n'), 'click');
		});

		await t.step('a navigation task really moves the browser', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const result = await h.callJson<TaskResult>('browser_run_task', {
				task: 'Go to the second page and report the marker on it.',
				max_steps: 5,
			});
			assertEquals(result.status, 'done');
			assertEquals(result.answer, 'arrived-at-second');
			const state = await h.callJson<{ title: string }>('browser_get_state', {});
			assertEquals(state.title, 'Second Page');
		});

		await t.step('a typing task puts real characters in the field', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const wanted = `agent-${h.site.nonce.slice(0, 6)}`;
			const result = await h.callJson<TaskResult>('browser_run_task', {
				task: `Type "${wanted}" into the field and report what it shows.`,
				max_steps: 5,
			});
			assertEquals(result.status, 'done');
			assertEquals(result.answer, wanted);
			assertStringIncludes(await h.callText('browser_get_html', {}), `>${wanted}</div>`);
		});

		await t.step('a failing action becomes feedback rather than a crash', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const result = await h.callJson<TaskResult>('browser_run_task', {
				task: 'Do something impossible.',
				max_steps: 3,
			});
			// The budget runs out rather than the run exploding, and the history
			// records the real tool error the model would have seen.
			assertEquals(result.status, 'budget-exhausted');
			assertEquals(result.resumable, true);
			// Either index-family code, and which one is the model's choice rather than the product's:
			// E-36 split the single `unknown-index` into two, so a model that acted on an index without
			// reading the state first now gets `element-not-found` (there is no table to address) while
			// one that read first and then guessed still gets `unknown-index`. Pinning one spelling here
			// would make an LLM's step ordering a build gate.
			const history = result.history.join('\n');
			assert(
				history.includes('unknown-index') || history.includes('element-not-found'),
				`no index-family tool error in the history: ${history}`,
			);
		});

		await t.step('a parked run can be resumed instead of restarted', async () => {
			// The previous step left a parked run on the default session.
			const resumed = await h.callJson<TaskResult>('browser_run_task', { resume: true, max_steps: 2 });
			assertEquals(resumed.status, 'budget-exhausted');
			assertEquals(resumed.steps, 2, 'a resumed run starts a fresh budget');
		});

		await t.step('the loop refuses a mutating run while a human holds control', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const socket = await h.live();
			const meta = await socket.ready();
			socket.send({ type: 'control.take' });
			await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);

			// G-2: the loop stays listed and refuses at call time with the code a
			// model can act on. It used to be withdrawn from `tools/list` and
			// answered `disabled` — a weaker message, and on the all-held path a
			// JSON-RPC error, which aborts the turn rather than saying "wait".
			const refused = await h.callError('browser_run_task', { task: 'x' });
			assertStringIncludes(refused, 'Error: human-has-control');
			// And the reason is discoverable from the tool that still works.
			const state = await h.callJson<{ human_has_control: boolean }>('browser_get_state', {});
			assertEquals(state.human_has_control, true);
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e R2: a model that will not answer in JSON does not end the run',
	ignore,
	async fn() {
		await using h = await harness({ sampling: babblingResponder(), maxRounds: 12 });
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const result = await h.callJson<TaskResult>('browser_run_task', {
			task: 'Press the button.',
			max_steps: 3,
		});
		// Every reply was prose, so nothing was executed — but the run reports
		// that honestly instead of throwing a parse error at the caller.
		assertEquals(result.status, 'budget-exhausted');
		assertEquals(result.steps, 3);
		assertStringIncludes(result.history.join('\n'), 'unparseable reply');
	},
});

Deno.test({
	name: 'e2e R2: the task scope gates the autonomous loop',
	ignore,
	async fn() {
		await using h = await harness({
			scopes: ['mcp:invoke', 'view:watch'],
			sampling: agentResponder(),
		});
		const names = (await h.client.listTools({})).tools.map((tool) => tool.name);
		assert(!names.includes('browser_run_task'), 'the loop must not be offered without the task scope');
		assert(names.includes('browser_extract_content'), 'extraction needs no extra scope');
	},
});

// --- the opt-in real-model leg ----------------------------------------------

const noModel = ignore || !hasRealModel();
if (!ignore) {
	// Named either way. A leg that silently does not run is the failure the tier
	// support exists to prevent, and a leg that ran against a model you did not
	// expect is worse than one that did not run.
	console.error(
		hasRealModel()
			? `agent e2e: real-model leg will run against ${realModelDescription()}`
			: 'agent e2e: skipping the real-model leg — configure one in `openai_compatible_api` ' +
				'(BaseURL/api_key/model, or model_1/model_2/… for several), or set TTK_MODEL_BASE_URL ' +
				'or ANTHROPIC_API_KEY',
	);
}

/**
 * One pass per configured model.
 *
 * Running several is not redundancy. Models differ in exactly the ways these
 * prompts have to survive — the two configured here differ in whether they think
 * before answering, and the reply shape that found E-28 (a `{thought}` object
 * followed by a separate `{action}` object) is produced by only one of them. A
 * suite that proves the prompts work for one model proves it for one model.
 */
for (const model of noModel ? [] : realModels()) {
	Deno.test({
		name: `e2e R1 (real model ${model}): the model answers from the real page`,
		async fn() {
			await using h = await harness({ sampling: realModelResponder(model) });
			await h.callText('browser_navigate', { url: h.site.page('article') });

			const result = await h.callJson<ExtractResult>('browser_extract_content', {
				query: 'What was the revenue, and who is the chief executive? Answer in one line.',
			});
			// A real model, reading the real DOM this server extracted.
			assertStringIncludes(result.result, '42');
			assertStringIncludes(result.result, 'Dana Whitfield');
			// And the answer is attributed to the model that was actually called,
			// not to a fixture responder that happened to be wired in by mistake.
			assertStringIncludes(result.model, model);
		},
	});

	Deno.test({
		name: `e2e R2 (real model ${model}): the model drives the browser to the task`,
		async fn(t) {
			await using h = await harness({ sampling: realModelResponder(model), maxRounds: 20 });

			// The tasks are phrased as a person would phrase them, not as a DOM
			// query. That is a constraint the observation imposes and it is worth
			// stating: the model is given the page as text plus the *interactive*
			// elements, so page content carries no element ids. An earlier version
			// asked for "the text in the element with id out" and the model clicked
			// the button six times over — it had done the task and had no way to see
			// that it had (E-26). A caller who needs ids has browser_get_html.
			await t.step('a click task completes and reports what the page then showed', async () => {
				await h.callText('browser_navigate', { url: h.site.page('index') });
				const result = await h.callJson<TaskResult>('browser_run_task', {
					task: 'Press the button and report the text the page then shows.',
					max_steps: 6,
				});
				assertEquals(result.status, 'done', `history:\n${result.history.join('\n')}`);
				// The nonce is generated for this run, so a real model produced it
				// only by clicking the real button and reading the resulting page.
				assertStringIncludes(result.answer ?? '', `clicked-${h.site.nonce}`);
				assertStringIncludes(await h.callText('browser_get_html', {}), `clicked-${h.site.nonce}`);
			});

			await t.step('a navigation task really moves the browser', async () => {
				await h.callText('browser_navigate', { url: h.site.page('index') });
				const result = await h.callJson<TaskResult>('browser_run_task', {
					task: 'Follow the link to the second page, then report the heading you find there.',
					max_steps: 6,
				});
				assertEquals(result.status, 'done', `history:\n${result.history.join('\n')}`);
				// Checked on the browser rather than on the model's word for it.
				const state = await h.callJson<{ url: string; title: string }>('browser_get_state', {});
				assertEquals(state.title, 'Second Page');
				assertStringIncludes(state.url, '/second');
			});
		},
	});
}
