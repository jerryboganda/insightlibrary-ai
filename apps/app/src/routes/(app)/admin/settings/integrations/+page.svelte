<script lang="ts">
	import { Key, Plus, Copy, Check, Webhook, X, Trash2 } from '@lucide/svelte';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';

	const queryClient = useQueryClient();

	// Live API keys — fields: id, name, tokenHint, createdAt, lastUsedAt.
	const keysQuery = createQuery({
		queryKey: ['apiKeys'],
		queryFn: () => api.listApiKeys()
	});
	const apiKeys = $derived($keysQuery.data ?? []);

	// Live webhooks — fields: id, url, event, active.
	const webhooksQuery = createQuery({
		queryKey: ['webhooks'],
		queryFn: () => api.listWebhooks()
	});
	const webhooks = $derived($webhooksQuery.data ?? []);

	// ── Create API key ────────────────────────────────────────────────────────────
	// The full token is only returned once, so surface it in a one-time notice box.
	let newKeyName = $state('');
	let showNameInput = $state(false);
	let revealedToken = $state<string | null>(null);
	let revealedTokenCopied = $state(false);

	const createKey = createMutation({
		mutationFn: (name: string) => api.createApiKey(name),
		onSuccess: (created) => {
			revealedToken = created.token;
			revealedTokenCopied = false;
			newKeyName = '';
			showNameInput = false;
			queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
		}
	});

	function submitCreateKey() {
		const name = newKeyName.trim();
		if (!name) return;
		$createKey.mutate(name);
	}

	function copyRevealedToken() {
		if (!revealedToken) return;
		navigator.clipboard.writeText(revealedToken);
		revealedTokenCopied = true;
		setTimeout(() => (revealedTokenCopied = false), 2000);
	}

	// ── Revoke API key ──────────────────────────────────────────────────────────────
	const revokeKey = createMutation({
		mutationFn: (id: string) => api.deleteApiKey(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] })
	});

	// ── Add webhook endpoint ──────────────────────────────────────────────────────
	let newWebhookUrl = $state('');
	let showWebhookInput = $state(false);

	const createEndpoint = createMutation({
		mutationFn: (url: string) => api.createWebhook(url),
		onSuccess: () => {
			newWebhookUrl = '';
			showWebhookInput = false;
			queryClient.invalidateQueries({ queryKey: ['webhooks'] });
		}
	});

	function submitCreateEndpoint() {
		const url = newWebhookUrl.trim();
		if (!url) return;
		$createEndpoint.mutate(url);
	}

	const deleteEndpoint = createMutation({
		mutationFn: (id: string) => api.deleteWebhook(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] })
	});
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header class="flex items-end justify-between gap-4">
		<div>
			<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
				<Key class="h-6 w-6 text-indigo-400" />
				API Keys & Integrations
			</h1>
			<p class="mt-2 text-sm text-zinc-400">
				Manage headless access to your SSOT Engine and configure webhooks.
			</p>
		</div>
		{#if showNameInput}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					submitCreateKey();
				}}
				class="flex items-center gap-2"
			>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:value={newKeyName}
					autofocus
					placeholder="Key name…"
					class="w-44 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
				/>
				<button
					type="submit"
					disabled={$createKey.isPending || !newKeyName.trim()}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Plus class="h-4 w-4" /> {$createKey.isPending ? 'Creating…' : 'Create'}
				</button>
				<button
					type="button"
					onclick={() => {
						showNameInput = false;
						newKeyName = '';
					}}
					class="rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
					aria-label="Cancel"
				>
					<X class="h-4 w-4" />
				</button>
			</form>
		{:else}
			<button
				onclick={() => (showNameInput = true)}
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
			>
				<Plus class="h-4 w-4" /> Create API Key
			</button>
		{/if}
	</header>

	<!-- One-time token reveal notice -->
	{#if revealedToken}
		<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h3 class="flex items-center gap-2 text-sm font-semibold text-emerald-300">
						<Check class="h-4 w-4" /> API key created
					</h3>
					<p class="mt-1 text-xs text-zinc-400">
						Copy your new key now — for security it will only be shown once.
					</p>
					<div class="mt-3 flex items-center gap-2">
						<code
							class="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-xs text-emerald-200"
						>
							{revealedToken}
						</code>
						<button
							onclick={copyRevealedToken}
							class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
						>
							{#if revealedTokenCopied}
								<Check class="h-3.5 w-3.5 text-emerald-400" /> Copied
							{:else}
								<Copy class="h-3.5 w-3.5" /> Copy
							{/if}
						</button>
					</div>
					<p class="mt-3 text-xs text-zinc-500">
						Send it as a bearer token on every API request, for example:
					</p>
					<code
						class="mt-1.5 block truncate rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-[11px] text-zinc-400"
					>
						curl -H "Authorization: Bearer {revealedToken}" https://&lt;your-server&gt;/api/topics
					</code>
				</div>
				<button
					onclick={() => (revealedToken = null)}
					class="-mt-1 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
					aria-label="Dismiss"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
		</div>
	{/if}

	<!-- API Keys -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="text-lg font-semibold text-zinc-100">Active API Keys</h2>
			<p class="mt-1 text-xs text-zinc-500">
				Authenticate requests with the
				<code class="rounded bg-zinc-900 px-1 py-0.5 font-mono text-zinc-400"
					>Authorization: Bearer sk_live_…</code
				>
				header. The full secret is shown only once, at creation — the masked hint below cannot be
				used to authenticate.
			</p>
		</div>
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm whitespace-nowrap">
				<thead class="bg-zinc-900/50 text-[10px] tracking-wider text-zinc-400 uppercase">
					<tr>
						<th class="px-6 py-3 font-semibold">Name</th>
						<th class="px-6 py-3 font-semibold">Key/Token</th>
						<th class="px-6 py-3 font-semibold">Created</th>
						<th class="px-6 py-3 font-semibold">Last Used</th>
						<th class="px-6 py-3 text-right font-semibold">Action</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
					{#if $keysQuery.isLoading}
						<tr>
							<td colspan="5" class="px-6 py-12 text-center text-zinc-500">Loading API keys…</td>
						</tr>
					{:else if $keysQuery.isError}
						<tr>
							<td colspan="5" class="px-6 py-12 text-center text-rose-300">
								Failed to load API keys. Please try again.
							</td>
						</tr>
					{:else if apiKeys.length === 0}
						<tr>
							<td colspan="5" class="px-6 py-12 text-center text-zinc-500">
								No API keys yet. Create one to enable headless access.
							</td>
						</tr>
					{:else}
						{#each apiKeys as key (key.id)}
							<tr class="transition-colors hover:bg-zinc-900/30">
								<td class="px-6 py-4 font-medium text-zinc-200">{key.name}</td>
								<td class="px-6 py-4">
									<span class="font-mono text-zinc-500" title="Masked hint — the full secret was shown once at creation">
										sk_live_{key.tokenHint}
									</span>
								</td>
								<td class="px-6 py-4">{key.createdAt}</td>
								<td class="px-6 py-4">{key.lastUsedAt ?? 'Never'}</td>
								<td class="px-6 py-4 text-right">
									<button
										onclick={() => $revokeKey.mutate(key.id)}
										disabled={$revokeKey.isPending}
										class="text-xs font-medium text-rose-400 transition-colors hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
										>Revoke</button
									>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Webhooks -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<Webhook class="h-5 w-5 text-indigo-400" /> Webhooks
			</h2>
			{#if showWebhookInput}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						submitCreateEndpoint();
					}}
					class="flex items-center gap-2"
				>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						bind:value={newWebhookUrl}
						autofocus
						type="url"
						placeholder="https://example.com/hook"
						class="w-56 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<button
						type="submit"
						disabled={$createEndpoint.isPending || !newWebhookUrl.trim()}
						class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{$createEndpoint.isPending ? 'Adding…' : 'Save'}
					</button>
					<button
						type="button"
						onclick={() => {
							showWebhookInput = false;
							newWebhookUrl = '';
						}}
						class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Cancel"
					>
						<X class="h-4 w-4" />
					</button>
				</form>
			{:else}
				<button
					onclick={() => (showWebhookInput = true)}
					class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
					>Add Endpoint</button
				>
			{/if}
		</div>
		{#if $webhooksQuery.isLoading}
			<div class="p-6 py-12 text-center text-sm text-zinc-500">Loading webhooks…</div>
		{:else if webhooks.length === 0}
			<div class="p-6 py-12 text-center">
				<div
					class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900"
				>
					<Webhook class="h-5 w-5 text-zinc-500" />
				</div>
				<h3 class="mb-1 text-sm font-medium text-zinc-200">No webhooks configured</h3>
				<p class="mx-auto max-w-sm text-xs text-zinc-500">
					Set up webhooks to receive real-time HTTP payloads when SSOT documents are merged or conflicts
					require review.
				</p>
			</div>
		{:else}
			<ul class="divide-y divide-zinc-800/50">
				{#each webhooks as hook (hook.id)}
					<li class="flex items-center justify-between gap-4 px-6 py-4">
						<div class="min-w-0">
							<p class="truncate font-mono text-sm text-zinc-200">{hook.url}</p>
							<p class="mt-0.5 text-xs text-zinc-500">
								{hook.event}
								·
								<span class={hook.active ? 'text-emerald-400' : 'text-zinc-500'}>
									{hook.active ? 'Active' : 'Inactive'}
								</span>
							</p>
						</div>
						<button
							onclick={() => $deleteEndpoint.mutate(hook.id)}
							disabled={$deleteEndpoint.isPending}
							class="shrink-0 rounded-md p-2 text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
							aria-label="Delete webhook"
						>
							<Trash2 class="h-4 w-4" />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
