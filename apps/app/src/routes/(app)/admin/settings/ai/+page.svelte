<script lang="ts">
	import { onMount } from 'svelte';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Sparkles, Check, Trash2, AlertTriangle, KeyRound, LogIn } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import { chatGptOAuthSupported, signInWithChatGpt, getChatGptToken, signOutChatGpt } from '$lib/platform/oauth';
	import type { AiKeyInput, ProviderId } from '@insightlibrary/schemas';

	const providers = createQuery({ queryKey: ['ai-providers'], queryFn: () => api.getAiProviders() });
	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ai-providers'] });

	const saveKeyMut = createMutation({ mutationFn: (v: AiKeyInput) => api.saveAiKey(v), onSuccess: invalidate });
	const deleteKeyMut = createMutation({
		mutationFn: (p: ProviderId) => api.deleteAiKey(p, 'org'),
		onSuccess: invalidate
	});

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

	// Experimental desktop ChatGPT OAuth sign-in.
	let chatgpt = $state({ supported: false, connected: false, hint: '', busy: false, error: '' });
	onMount(async () => {
		chatgpt.supported = chatGptOAuthSupported();
		if (chatgpt.supported) {
			const t = await getChatGptToken();
			chatgpt.connected = !!t;
			if (t) chatgpt.hint = `••••${t.slice(-4)}`;
		}
	});
	async function connectChatGpt() {
		chatgpt.busy = true;
		chatgpt.error = '';
		try {
			const r = await signInWithChatGpt(api.baseUrl);
			chatgpt.connected = true;
			chatgpt.hint = r.hint;
		} catch (e) {
			chatgpt.error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			chatgpt.busy = false;
		}
	}
	async function disconnectChatGpt() {
		await signOutChatGpt();
		chatgpt.connected = false;
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

	{#if $providers.isLoading}
		<div class="space-y-3">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-24 rounded-xl" />
			{/each}
		</div>
	{:else}
		<div class="space-y-3">
			{#each $providers.data?.providers ?? [] as p (p.id)}
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
	{/if}

	{#if chatgpt.supported}
		<div class="glass-panel rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<LogIn class="h-4 w-4 text-amber-400" />
					<div>
						<h3 class="text-sm font-semibold text-zinc-100">Sign in with ChatGPT <span class="text-amber-400">(experimental)</span></h3>
						<p class="mt-0.5 text-xs text-zinc-500">
							{#if chatgpt.connected}
								<span class="text-emerald-400">Connected {chatgpt.hint}</span>
							{:else}
								Use your ChatGPT subscription on this desktop device. Off-label and may stop working.
							{/if}
						</p>
					</div>
				</div>
				{#if chatgpt.connected}
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
