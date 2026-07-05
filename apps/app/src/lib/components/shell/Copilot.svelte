<script lang="ts">
	import { fly, scale } from 'svelte/transition';
	import { tick, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Sparkles, X, Plus, MessageSquare, FileText, Search, Activity, Globe, Settings2, Paperclip, BookOpen } from '@lucide/svelte';
	import type { CopilotMode, CopilotAttachment } from '@insightlibrary/schemas';
	import { readSSE } from '@insightlibrary/api-client';
	import { api } from '$lib/api';
	import { cn } from '$lib/utils';

	interface Msg {
		id: number;
		sender: 'user' | 'agent';
		text: string;
	}

	// 13 copilot modes (label → backend enum), mirroring the prototype.
	const modes: Array<{ name: string; value: CopilotMode; icon: typeof MessageSquare }> = [
		{ name: 'Ask Anything', value: 'ask', icon: MessageSquare },
		{ name: 'Strict Citation Mode', value: 'strict_citation', icon: FileText },
		{ name: 'Research Mode', value: 'research', icon: Search },
		{ name: 'Compare Mode', value: 'compare', icon: FileText },
		{ name: 'Contradiction Mode', value: 'contradiction', icon: Activity },
		{ name: 'Study Mode', value: 'study', icon: FileText },
		{ name: 'Teacher Mode', value: 'teacher', icon: FileText },
		{ name: 'Exam Mode', value: 'exam', icon: FileText },
		{ name: 'Summarize Mode', value: 'summarize', icon: FileText },
		{ name: 'Deep Reasoning Mode', value: 'deep_reasoning', icon: Sparkles },
		{ name: 'Fast Answer Mode', value: 'fast_answer', icon: Activity },
		{ name: 'SSOT Mode', value: 'ssot', icon: Globe },
		{ name: 'Delta Knowledge Mode', value: 'delta', icon: Settings2 }
	];

	const byValue = (v: CopilotMode) => modes.find((m) => m.value === v) ?? modes[0];

	let open = $state(true);
	let modeOpen = $state(false);
	let mode = $state(byValue('ask'));
	let input = $state('');
	let streaming = $state(false);
	let scroller = $state<HTMLDivElement>();

	// The workspace's default answering policy decides the initial copilot mode
	// (strict_citation when strictCitationDefault is on). Loaded once on mount;
	// silently keeps 'ask' if settings are unreachable.
	onMount(async () => {
		try {
			const s = await api.getOrgSettings();
			mode = byValue(s.settings.strictCitationDefault ? 'strict_citation' : 'ask');
		} catch {
			/* keep default */
		}
	});

	// ── Attach an in-context reference (topic/document) the answer is grounded in.
	// This is NOT a file upload: the copilot route grounds on an entity's
	// claims/chunks, so the picker lists real topics & documents by id.
	let attachOpen = $state(false);
	let attachment = $state<CopilotAttachment | null>(null);
	let attachLoading = $state(false);
	let attachError = $state<string | null>(null);
	let attachOptions = $state<CopilotAttachment[]>([]);
	let attachLoaded = false;
	let attachFilter = $state('');

	async function openAttach() {
		attachOpen = !attachOpen;
		if (!attachOpen || attachLoaded) return;
		attachLoading = true;
		attachError = null;
		try {
			const [topics, documents] = await Promise.all([
				api.listTopics().catch(() => []),
				api.listDocuments().catch(() => [])
			]);
			attachOptions = [
				...topics.map((t) => ({ kind: 'topic' as const, id: t.id, label: t.name })),
				...documents.map((d) => ({ kind: 'document' as const, id: d.id, label: d.title }))
			];
			attachLoaded = true;
		} catch (e) {
			attachError = e instanceof Error ? e.message : 'Could not load context items.';
		} finally {
			attachLoading = false;
		}
	}

	function pickAttachment(a: CopilotAttachment) {
		attachment = a;
		attachOpen = false;
		attachFilter = '';
	}

	const filteredOptions = $derived.by(() => {
		const q = attachFilter.trim().toLowerCase();
		if (!q) return attachOptions;
		return attachOptions.filter((o) => (o.label ?? o.id).toLowerCase().includes(q));
	});

	let messages = $state<Msg[]>([
		{
			id: 1,
			sender: 'agent',
			text: 'Grounded in your single source of truth. Ask a question, or attach a topic or document to scope the answer.'
		}
	]);

	/** If viewing a topic, ground strict-citation / SSOT answers in it. */
	const topicId = $derived.by(() => {
		const m = page.url.pathname.match(/^\/topics\/([^/]+)/);
		return m?.[1];
	});

	async function scrollDown() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function send() {
		if (!input.trim() || streaming) return;
		const userMsg: Msg = { id: Date.now(), sender: 'user', text: input };
		const agentMsg: Msg = { id: Date.now() + 1, sender: 'agent', text: '' };
		messages = [...messages, userMsg, agentMsg];
		const prompt = input;
		input = '';
		streaming = true;
		await scrollDown();

		try {
			const res = await api.copilotStream({
				mode: mode.value,
				message: prompt,
				topicId,
				attachment: attachment ?? undefined
			});
			await readSSE<{ type: string; value: string }>(res, (chunk) => {
				if (chunk.type === 'token') {
					agentMsg.text += chunk.value;
					messages = [...messages];
					void scrollDown();
				} else if (chunk.type === 'error') {
					agentMsg.text += `\n[error: ${chunk.value}]`;
					messages = [...messages];
				}
			});
		} catch (e) {
			agentMsg.text = `Failed to reach the copilot service. ${e instanceof Error ? e.message : ''}`;
			messages = [...messages];
		} finally {
			streaming = false;
		}
	}
</script>

{#if !open}
	<button
		transition:scale={{ duration: 150 }}
		onclick={() => (open = true)}
		class="fixed right-6 bottom-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
		aria-label="Open copilot"
	>
		<Sparkles class="h-5 w-5" />
	</button>
{:else}
	<div
		transition:fly={{ x: 20, duration: 200 }}
		class="glass-panel fixed right-6 bottom-6 z-50 flex h-[600px] max-h-[calc(100vh-48px)] w-80 flex-col overflow-hidden rounded-xl border border-zinc-800 shadow-2xl lg:w-96"
	>
		<div class="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4">
			<div class="flex items-center gap-2 text-sm font-medium text-indigo-300">
				<Sparkles class="h-4 w-4" /> Copilot SDK Agent
			</div>
			<button onclick={() => (open = false)} class="text-zinc-500 hover:text-zinc-300" aria-label="Close">
				<X class="h-4 w-4" />
			</button>
		</div>

		<div bind:this={scroller} class="flex-1 space-y-4 overflow-y-auto p-4">
			{#each messages as msg (msg.id)}
				<div class={cn('flex gap-2', msg.sender === 'user' ? 'flex-row-reverse' : 'flex-row')}>
					<div
						class={cn(
							'flex h-6 w-6 shrink-0 items-center justify-center rounded',
							msg.sender === 'user' ? 'bg-zinc-800 text-[10px] font-bold text-zinc-300' : 'bg-indigo-500/20'
						)}
					>
						{#if msg.sender === 'user'}IL{:else}<Sparkles class="h-3.5 w-3.5 text-indigo-400" />{/if}
					</div>
					<div
						class={cn(
							'max-w-[85%] rounded-lg border p-3 text-sm whitespace-pre-wrap',
							msg.sender === 'user'
								? 'rounded-tr-none border-indigo-500/20 bg-indigo-900/40 text-zinc-200'
								: 'rounded-tl-none border-zinc-800 bg-zinc-900/80 text-zinc-300'
						)}
					>
						{msg.text}{#if streaming && msg.sender === 'agent' && msg === messages[messages.length - 1]}<span class="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-indigo-400 align-middle"></span>{/if}
					</div>
				</div>
			{/each}
		</div>

		<div class="relative shrink-0 border-t border-zinc-800 bg-zinc-900/80 p-3">
			{#if modeOpen}
				<div class="absolute bottom-full left-3 mb-2 z-10 w-48 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
					{#each modes as m (m.value)}
						<button
							onclick={() => {
								mode = m;
								modeOpen = false;
							}}
							class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
						>
							<m.icon class="h-3.5 w-3.5" /> {m.name}
						</button>
					{/each}
				</div>
			{/if}
			{#if attachOpen}
				<div class="absolute bottom-full left-3 mb-2 z-10 flex max-h-72 w-64 flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
					<div class="border-b border-zinc-800 p-2">
						<input
							bind:value={attachFilter}
							placeholder="Filter topics & documents…"
							class="w-full rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
						/>
					</div>
					<div class="flex-1 overflow-y-auto p-1">
						{#if attachLoading}
							<p class="px-2 py-3 text-center text-[11px] text-zinc-500">Loading context items…</p>
						{:else if attachError}
							<p class="px-2 py-3 text-center text-[11px] text-rose-400">{attachError}</p>
						{:else if filteredOptions.length === 0}
							<p class="px-2 py-3 text-center text-[11px] text-zinc-500">
								{attachOptions.length === 0 ? 'No topics or documents yet.' : 'No matches.'}
							</p>
						{:else}
							{#each filteredOptions as opt (opt.kind + opt.id)}
								<button
									onclick={() => pickAttachment(opt)}
									class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
								>
									{#if opt.kind === 'topic'}<BookOpen class="h-3.5 w-3.5 shrink-0 text-indigo-400" />{:else}<FileText class="h-3.5 w-3.5 shrink-0 text-sky-400" />{/if}
									<span class="truncate">{opt.label ?? opt.id}</span>
								</button>
							{/each}
						{/if}
					</div>
				</div>
			{/if}
			<div class="mb-2 flex items-center gap-2">
				<button
					onclick={() => {
						modeOpen = !modeOpen;
						attachOpen = false;
					}}
					class="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-700"
				>
					<FileText class="h-3 w-3 text-indigo-400" /> {mode.name}
				</button>
				{#if attachment}
					<span
						class="flex items-center gap-1 rounded bg-indigo-500/15 px-2 py-0.5 text-[10px] text-indigo-300"
					>
						{#if attachment.kind === 'topic'}<BookOpen class="h-3 w-3" />{:else}<FileText class="h-3 w-3" />{/if}
						<span class="max-w-[8rem] truncate">{attachment.label ?? attachment.id}</span>
						<button
							type="button"
							onclick={() => (attachment = null)}
							class="text-indigo-400 hover:text-indigo-200"
							aria-label="Remove attachment"
						>
							<X class="h-3 w-3" />
						</button>
					</span>
				{/if}
			</div>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					send();
				}}
				class="relative flex items-center rounded-md border border-zinc-800 bg-zinc-950 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50"
			>
				<button
					type="button"
					onclick={openAttach}
					class={cn(
						'ml-1 rounded p-1.5 transition-colors hover:bg-zinc-800 hover:text-zinc-300',
						attachment ? 'text-indigo-400' : 'text-zinc-500'
					)}
					aria-label="Attach a topic or document as context"
					title="Attach a topic or document as context"
				>
					{#if attachment}<Paperclip class="h-4 w-4" />{:else}<Plus class="h-4 w-4" />{/if}
				</button>
				<input
					bind:value={input}
					placeholder="Ask a question or issue a command..."
					class="flex-1 bg-transparent py-2 pr-2 pl-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
				/>
				<button type="submit" disabled={streaming} class="mr-1 rounded p-1.5 text-indigo-400 hover:bg-zinc-800 disabled:opacity-40" aria-label="Send">
					<MessageSquare class="h-4 w-4" />
				</button>
			</form>
		</div>
	</div>
{/if}
