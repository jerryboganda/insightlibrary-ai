<script lang="ts">
	import { onMount } from 'svelte';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		Sparkles,
		Check,
		Trash2,
		AlertTriangle,
		KeyRound,
		LogIn,
		Route,
		Database,
		RefreshCw
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import {
		chatGptOAuthSupported,
		signInWithChatGpt,
		getChatGptConnectionStatus,
		signOutChatGpt
	} from '$lib/platform/oauth';
	import type { AiKeyInput, AiProviderSettingsInput, ProviderId } from '@insightlibrary/schemas';

	const providers = createQuery({ queryKey: ['ai-providers'], queryFn: () => api.getAiProviders() });
	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ai-providers'] });

	const saveKeyMut = createMutation({ mutationFn: (v: AiKeyInput) => api.saveAiKey(v), onSuccess: invalidate });
	const deleteKeyMut = createMutation({
		mutationFn: (p: ProviderId) => api.deleteAiKey(p, 'org'),
		onSuccess: invalidate
	});

	// Chat/LLM providers vs vendor service keys (rerank/parsing) — rendered apart.
	const chatProviders = $derived(($providers.data?.providers ?? []).filter((p) => p.kind !== 'vendor'));
	const vendorProviders = $derived(($providers.data?.providers ?? []).filter((p) => p.kind === 'vendor'));
	const embeddings = $derived($providers.data?.embeddings);

	// Per-provider input drafts, seeded once the provider list loads.
	let drafts = $state<Record<string, { apiKey: string; baseUrl: string; model: string }>>({});
	$effect(() => {
		for (const p of $providers.data?.providers ?? []) {
			if (!drafts[p.id]) drafts[p.id] = { apiKey: '', baseUrl: '', model: p.model ?? '' };
		}
	});

	function saveKey(id: ProviderId) {
		const d = drafts[id];
		if (!d?.apiKey.trim()) return;
		$saveKeyMut.mutate({
			provider: id,
			apiKey: d.apiKey.trim(),
			baseUrl: d.baseUrl.trim() || undefined,
			model: d.model.trim() || undefined,
			scope: 'org'
		});
		d.apiKey = '';
	}

	// ── Org routing (default provider + per-task overrides) ───────────────────
	// 'embedding' is deliberately absent: embeddings are pinned to Gemini's
	// 768-dim vector space (see the status card) and routing it would be a lie.
	const ROUTABLE_TASKS: { id: string; label: string; hint: string }[] = [
		{ id: 'chat', label: 'Chat / Copilot', hint: 'Interactive copilot answers' },
		{ id: 'extraction', label: 'Extraction', hint: 'Claim & structure extraction during ingestion' },
		{ id: 'synthesis', label: 'Synthesis', hint: 'Topic compose, cases, reports' },
		{ id: 'nli', label: 'Verification (NLI)', hint: 'Entailment checks, dedup, conflicts' },
		{ id: 'rerank', label: 'LLM Rerank', hint: 'Search result reranking (when set to llm)' }
	];

	let routingDefault = $state('');
	let routingTasks = $state<Record<string, string>>({});
	let routingSeeded = $state(false);
	$effect(() => {
		const d = $providers.data;
		if (!d || routingSeeded) return;
		routingDefault = d.defaultProvider ?? '';
		const seeded: Record<string, string> = {};
		for (const t of ROUTABLE_TASKS) seeded[t.id] = d.taskRouting?.[t.id] ?? '';
		routingTasks = seeded;
		routingSeeded = true;
	});

	let routingNotice = $state('');
	let routingTimer: ReturnType<typeof setTimeout> | undefined;
	const saveRoutingMut = createMutation({
		mutationFn: (input: AiProviderSettingsInput) => api.setAiProviderSettings(input),
		onSuccess: () => {
			invalidate();
			routingNotice = 'Routing saved';
			clearTimeout(routingTimer);
			routingTimer = setTimeout(() => (routingNotice = ''), 3000);
		}
	});

	function saveRouting() {
		// taskRouting replaces the stored map — send only non-empty picks.
		const taskRouting: Record<string, string> = {};
		for (const [task, provider] of Object.entries(routingTasks)) {
			if (provider) taskRouting[task] = provider;
		}
		$saveRoutingMut.mutate({ defaultProvider: routingDefault || null, taskRouting });
	}

	// Experimental desktop ChatGPT OAuth sign-in.
	let chatgpt = $state({
		supported: false,
		connected: false,
		needsReconnect: false,
		hint: '',
		busy: false,
		error: ''
	});
	async function refreshChatGptStatus() {
		const s = await getChatGptConnectionStatus(api.baseUrl);
		chatgpt.connected = s.connected;
		chatgpt.needsReconnect = s.needsReconnect;
	}
	onMount(async () => {
		chatgpt.supported = chatGptOAuthSupported();
		if (chatgpt.supported) await refreshChatGptStatus();
	});
	async function connectChatGpt() {
		chatgpt.busy = true;
		chatgpt.error = '';
		try {
			const r = await signInWithChatGpt(api.baseUrl);
			chatgpt.hint = r.hint;
			await refreshChatGptStatus();
		} catch (e) {
			chatgpt.error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			chatgpt.busy = false;
		}
	}
	async function disconnectChatGpt() {
		await signOutChatGpt();
		chatgpt.connected = false;
		chatgpt.needsReconnect = false;
		chatgpt.hint = '';
	}
</script>

<div class="mx-auto max-w-4xl space-y-8 p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Sparkles class="h-6 w-6 text-indigo-400" />
			AI Providers
		</h1>
		<p class="mt-1 text-sm text-zinc-400">
			Bring your own API keys. All AI runs server-side; keys are encrypted at rest and never sent to the
			browser. Gemini, Claude, OpenAI, Kimi (Moonshot), DeepSeek, MiniMax and any OpenAI-compatible
			endpoint are supported.
		</p>
	</header>

	{#if $providers.data && !$providers.data.encryptionAvailable}
		<div class="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
			<div>
				Server key storage is disabled. Set <code class="rounded bg-zinc-800 px-1">MASTER_ENCRYPTION_KEY</code>
				(32 bytes, hex or base64) on the server to store keys. Until then, configure keys via server env vars.
			</div>
		</div>
	{/if}

	<!-- Embeddings health (C4): vector search, dedup, conflict detection and
	     ontology linking all ride on this — degrade loudly when unconfigured. -->
	{#if embeddings}
		{#if !embeddings.configured}
			<div class="flex items-start gap-3 rounded-lg border border-rose-500/50 bg-rose-500/10 p-4 text-sm text-rose-300">
				<Database class="mt-0.5 h-4 w-4 shrink-0" />
				<div>
					<span class="font-semibold">Embeddings are not configured.</span>
					Vector search, deduplication, conflict detection and ontology linking are degraded to
					text-only fallbacks. Save a <span class="font-medium">Google Gemini</span> API key below (or set
					<code class="rounded bg-zinc-900 px-1">GEMINI_API_KEY</code> on the server) to restore them.
					Embeddings are Gemini-only: the vector index lives in the gemini-embedding-001 768-dimension
					space.
				</div>
			</div>
		{:else}
			<div class="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-300">
				<Database class="mt-0.5 h-4 w-4 shrink-0" />
				<div>
					Embeddings active via <span class="font-semibold">{embeddings.provider ?? 'gemini'}</span>
					({embeddings.source === 'stored' ? 'workspace key' : 'server env key'}). Vector search, dedup,
					conflict detection and ontology linking are operational.
				</div>
			</div>
		{/if}
	{/if}

	<!-- Org routing: default provider + per-task overrides (A8). -->
	<section class="glass-panel rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-5">
			<h2 class="flex items-center gap-2 text-base font-semibold text-zinc-100">
				<Route class="h-4 w-4 text-indigo-400" /> Model Routing
			</h2>
			<p class="mt-1 text-xs text-zinc-500">
				Pick a workspace default provider and optional per-task overrides. "Auto" follows the
				precedence: per-task override → workspace default → server env → fallback order.
			</p>
		</div>
		{#if $providers.isLoading}
			<div class="space-y-3 p-5">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-9 rounded-md" />
				{/each}
			</div>
		{:else}
			<div class="space-y-4 p-5">
				<div class="flex items-center justify-between gap-4">
					<div>
						<h4 class="text-sm font-medium text-zinc-200">Default provider</h4>
						<p class="mt-0.5 text-xs text-zinc-500">Used for every task without an override.</p>
					</div>
					<select
						bind:value={routingDefault}
						class="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
					>
						<option value="">Auto (fallback order)</option>
						{#each chatProviders as p (p.id)}
							<option value={p.id} disabled={!p.keyStored && !p.envConfigured}>
								{p.label}{!p.keyStored && !p.envConfigured ? ' — no key' : ''}
							</option>
						{/each}
					</select>
				</div>
				<div class="border-t border-zinc-800"></div>
				{#each ROUTABLE_TASKS as task (task.id)}
					<div class="flex items-center justify-between gap-4">
						<div>
							<h4 class="text-sm font-medium text-zinc-200">{task.label}</h4>
							<p class="mt-0.5 text-xs text-zinc-500">
								{task.hint}
								{#if $providers.data?.taskProviders?.[task.id]}
									· effective now:
									<span
										class={cn(
											'font-medium',
											$providers.data.taskProviders[task.id] === 'mock' ? 'text-rose-400' : 'text-indigo-400'
										)}
									>
										{$providers.data.taskProviders[task.id] === 'mock'
											? 'none (mock)'
											: $providers.data.taskProviders[task.id]}
									</span>
								{/if}
							</p>
						</div>
						<select
							bind:value={routingTasks[task.id]}
							class="w-52 shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
						>
							<option value="">Auto</option>
							{#each chatProviders as p (p.id)}
								<option value={p.id} disabled={!p.keyStored && !p.envConfigured}>
									{p.label}{!p.keyStored && !p.envConfigured ? ' — no key' : ''}
								</option>
							{/each}
						</select>
					</div>
				{/each}
				<p class="text-[11px] text-zinc-600">
					Embedding routing is intentionally fixed to Gemini — the vector index is built in its
					768-dimension space and cannot mix providers.
				</p>
			</div>
			<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
				{#if routingNotice}
					<span class="text-sm font-medium text-emerald-400">{routingNotice}</span>
				{/if}
				{#if $saveRoutingMut.isError}
					<span class="text-xs text-rose-400">
						{$saveRoutingMut.error instanceof Error ? $saveRoutingMut.error.message : 'Save failed'}
					</span>
				{/if}
				<button
					onclick={saveRouting}
					disabled={$saveRoutingMut.isPending}
					class="rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
				>
					{$saveRoutingMut.isPending ? 'Saving…' : 'Save Routing'}
				</button>
			</div>
		{/if}
	</section>

	{#if $providers.isLoading}
		<div class="space-y-3">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-24 rounded-xl" />
			{/each}
		</div>
	{:else}
		<div class="space-y-3">
			{#each chatProviders as p (p.id)}
				<div class="glass-panel rounded-xl border border-zinc-800 p-5">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-3">
							<KeyRound class="h-4 w-4 text-zinc-500" />
							<div>
								<h3 class="text-sm font-semibold text-zinc-100">{p.label}</h3>
								<p class="mt-0.5 text-xs text-zinc-500">
									{#if p.keyStored}
										<span class="text-emerald-400">Key stored {p.hint}</span>
									{:else if p.envConfigured}
										<span class="text-sky-400">Configured via server env</span>
									{:else}
										Not configured
									{/if}
									{#if p.id === $providers.data?.activeChatProvider}
										· <span class="text-indigo-400">active for chat</span>
									{/if}
								</p>
							</div>
						</div>
						{#if p.keyStored}
							<button
								onclick={() => $deleteKeyMut.mutate(p.id)}
								class="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400"
							>
								<Trash2 class="h-3.5 w-3.5" /> Remove
							</button>
						{/if}
					</div>

					{#if drafts[p.id]}
						<div class="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
							<input
								type="password"
								placeholder="Paste API key…"
								bind:value={drafts[p.id].apiKey}
								class="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
							/>
							<button
								onclick={() => saveKey(p.id)}
								disabled={!drafts[p.id].apiKey.trim() || $saveKeyMut.isPending}
								class="flex items-center justify-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
							>
								<Check class="h-4 w-4" /> Save
							</button>
							<div class="grid gap-2 sm:col-span-2 sm:grid-cols-2">
								<input
									placeholder="Model (optional override)"
									bind:value={drafts[p.id].model}
									class="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
								/>
								{#if p.id === 'openai-compatible'}
									<input
										placeholder="Base URL (https://…/v1)"
										bind:value={drafts[p.id].baseUrl}
										class="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
									/>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if vendorProviders.length > 0}
			<section class="space-y-3">
				<div>
					<h2 class="text-base font-semibold text-zinc-100">Service Keys</h2>
					<p class="mt-0.5 text-xs text-zinc-500">
						Non-LLM vendor keys: Cohere / Jina power search reranking, LlamaParse powers external
						document parsing. Stored in the same encrypted store.
					</p>
				</div>
				{#each vendorProviders as p (p.id)}
					<div class="glass-panel rounded-xl border border-zinc-800 p-5">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<KeyRound class="h-4 w-4 text-zinc-500" />
								<div>
									<h3 class="text-sm font-semibold text-zinc-100">{p.label}</h3>
									<p class="mt-0.5 text-xs text-zinc-500">
										{#if p.keyStored}
											<span class="text-emerald-400">Key stored {p.hint}</span>
										{:else if p.envConfigured}
											<span class="text-sky-400">Configured via server env</span>
										{:else}
											Not configured
										{/if}
									</p>
								</div>
							</div>
							{#if p.keyStored}
								<button
									onclick={() => $deleteKeyMut.mutate(p.id)}
									class="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400"
								>
									<Trash2 class="h-3.5 w-3.5" /> Remove
								</button>
							{/if}
						</div>
						{#if drafts[p.id]}
							<div class="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
								<input
									type="password"
									placeholder="Paste API key…"
									bind:value={drafts[p.id].apiKey}
									class="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
								/>
								<button
									onclick={() => saveKey(p.id)}
									disabled={!drafts[p.id].apiKey.trim() || $saveKeyMut.isPending}
									class="flex items-center justify-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
								>
									<Check class="h-4 w-4" /> Save
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</section>
		{/if}
	{/if}

	{#if chatgpt.supported}
		<div
			class={cn(
				'glass-panel rounded-xl border p-5',
				chatgpt.needsReconnect ? 'border-rose-500/40 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'
			)}
		>
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<LogIn class={cn('h-4 w-4', chatgpt.needsReconnect ? 'text-rose-400' : 'text-amber-400')} />
					<div>
						<h3 class="text-sm font-semibold text-zinc-100">Sign in with ChatGPT <span class="text-amber-400">(experimental)</span></h3>
						<p class="mt-0.5 text-xs text-zinc-500">
							{#if chatgpt.needsReconnect}
								<span class="text-rose-400">Session expired and could not be refreshed — reconnect to keep using your subscription.</span>
							{:else if chatgpt.connected}
								<span class="text-emerald-400">Connected {chatgpt.hint}</span>
							{:else}
								Use your ChatGPT subscription on this desktop device. Off-label and may stop working.
							{/if}
						</p>
					</div>
				</div>
				{#if chatgpt.needsReconnect}
					<div class="flex items-center gap-2">
						<button
							onclick={connectChatGpt}
							disabled={chatgpt.busy}
							class="flex items-center gap-1.5 rounded-md border border-rose-500/50 bg-zinc-950 px-4 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
						>
							<RefreshCw class="h-3.5 w-3.5" />
							{chatgpt.busy ? 'Opening browser…' : 'Reconnect'}
						</button>
						<button onclick={disconnectChatGpt} class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">Sign out</button>
					</div>
				{:else if chatgpt.connected}
					<button onclick={disconnectChatGpt} class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400">Sign out</button>
				{:else}
					<button onclick={connectChatGpt} disabled={chatgpt.busy} class="rounded-md border border-amber-500/50 bg-zinc-950 px-4 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50">
						{chatgpt.busy ? 'Opening browser…' : 'Connect'}
					</button>
				{/if}
			</div>
			{#if chatgpt.error}
				<p class="mt-3 text-xs text-rose-400">{chatgpt.error}</p>
			{/if}
			<p class="mt-3 text-[11px] leading-relaxed text-zinc-600">
				By connecting you accept that reusing a consumer ChatGPT subscription for API-style use is not
				officially supported and may violate OpenAI's terms. Google consumer Gemini OAuth was retired in
				2026 — for Google use an AI Studio API key above.
			</p>
		</div>
	{/if}

	<p class={cn('text-xs text-zinc-600')}>
		All keys are stored encrypted server-side and used only for server-side inference — they never reach
		the browser.
	</p>
</div>
