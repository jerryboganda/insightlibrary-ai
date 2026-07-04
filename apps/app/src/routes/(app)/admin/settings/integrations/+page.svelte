<script lang="ts">
	import { Key, Plus, Copy, Check, Webhook } from '@lucide/svelte';

	// Inline integration data — no keys/webhooks endpoint yet (prototype spec).
	const apiKeys = [
		{
			id: 'k1',
			name: 'Production App Sync',
			token: 'sk_live_...4f92',
			created: 'May 10, 2026',
			lastUsed: '2 mins ago'
		}
	];

	let copiedId = $state<string | null>(null);

	function handleCopy(id: string) {
		copiedId = id;
		setTimeout(() => {
			if (copiedId === id) copiedId = null;
		}, 2000);
	}
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
		<button
			class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
		>
			<Plus class="h-4 w-4" /> Create API Key
		</button>
	</header>

	<!-- API Keys -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="text-lg font-semibold text-zinc-100">Active API Keys</h2>
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
					{#each apiKeys as key (key.id)}
						<tr class="transition-colors hover:bg-zinc-900/30">
							<td class="px-6 py-4 font-medium text-zinc-200">{key.name}</td>
							<td class="px-6 py-4">
								<span class="flex items-center gap-2 font-mono text-zinc-500">
									{key.token}
									<button
										onclick={() => handleCopy(key.id)}
										class="text-zinc-500 transition-colors hover:text-zinc-300"
										aria-label="Copy API key"
									>
										{#if copiedId === key.id}
											<Check class="h-3.5 w-3.5 text-emerald-400" />
										{:else}
											<Copy class="h-3.5 w-3.5" />
										{/if}
									</button>
								</span>
							</td>
							<td class="px-6 py-4">{key.created}</td>
							<td class="px-6 py-4">{key.lastUsed}</td>
							<td class="px-6 py-4 text-right">
								<button
									class="text-xs font-medium text-rose-400 transition-colors hover:text-rose-300"
									>Revoke</button
								>
							</td>
						</tr>
					{/each}
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
			<button class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
				>Add Endpoint</button
			>
		</div>
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
	</section>
</div>
