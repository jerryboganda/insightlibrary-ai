<script lang="ts">
	import { HardDrive, Database, Network, RefreshCw, AlertTriangle, X } from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';

	const queryClient = useQueryClient();

	// Re-embedding is a paid AI operation — gate it behind an explicit
	// confirmation so a stray click never spends tokens.
	let confirmOpen = $state(false);

	// Short-lived notices shown next to the tool after it runs.
	let rebuildNotice = $state('');
	let rebuildProgress = $state('');

	// Re-embed the vector index. The endpoint processes up to 500 chunks per
	// call, so loop until the server reports nothing remaining instead of
	// asking the admin to keep re-clicking.
	const rebuild = createMutation({
		mutationFn: async () => {
			let total = 0;
			let batches = 0;
			for (;;) {
				const res = await api.reindex();
				total += res.reembedded;
				batches += 1;
				rebuildProgress = `Re-embedded ${total} chunk${total === 1 ? '' : 's'} so far (batch ${batches})…`;
				if (!res.remaining) break;
				// Safety valve: a batch reporting progress-less "remaining" would
				// otherwise loop (and bill) forever.
				if (res.reembedded === 0) break;
			}
			return total;
		},
		onSuccess: (total) => {
			rebuildProgress = '';
			rebuildNotice = `Done — re-embedded ${total} chunk${total === 1 ? '' : 's'}.`;
			queryClient.invalidateQueries({ queryKey: ['usage'] });
		},
		onError: () => {
			rebuildProgress = '';
			rebuildNotice =
				'Re-embedding failed part-way. Chunks already processed are kept — run again to continue.';
			queryClient.invalidateQueries({ queryKey: ['usage'] });
		}
	});

	function startRebuild() {
		confirmOpen = false;
		rebuildNotice = '';
		$rebuild.mutate();
	}

	// Inline storage figures — no capacity endpoint yet (prototype spec).
	const stores = [
		{
			id: 'vector',
			label: 'Vector Database',
			icon: Database,
			iconColor: 'text-emerald-400',
			barColor: 'bg-emerald-400',
			value: '142',
			unit: ' GB',
			sub: 'of 500 GB',
			pct: 28
		},
		{
			id: 'graph',
			label: 'Knowledge Graph',
			icon: Network,
			iconColor: 'text-indigo-400',
			barColor: 'bg-indigo-400',
			value: '1.2M',
			unit: ' Nodes',
			sub: '8.4M Edges',
			pct: 45
		},
		{
			id: 'object',
			label: 'Object Storage (PDFs)',
			icon: HardDrive,
			iconColor: 'text-purple-400',
			barColor: 'bg-purple-400',
			value: '8.4',
			unit: ' TB',
			sub: 'Unlimited',
			pct: 10
		}
	];
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<HardDrive class="h-6 w-6 text-indigo-400" />
			Storage & Indices
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Manage vector database capacity, knowledge graph nodes, and re-indexing jobs.
		</p>
	</header>

	<!-- Storage Overview -->
	<div class="grid grid-cols-1 gap-6 md:grid-cols-3">
		{#each stores as store, i (store.id)}
			<div
				in:fly={{ y: 8, duration: 250, delay: i * 50 }}
				class="glass-panel relative flex flex-col justify-between overflow-hidden rounded-xl border border-zinc-800 p-6"
			>
				<div class="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-400">
					<store.icon class="h-4 w-4 {store.iconColor}" />
					{store.label}
				</div>
				<div>
					<div class="mb-2 flex items-end justify-between">
						<span class="text-2xl font-bold text-zinc-100"
							>{store.value}<span class="text-sm font-normal text-zinc-500">{store.unit}</span></span
						>
						<span class="text-xs font-medium text-zinc-500">{store.sub}</span>
					</div>
					<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
						<div class="h-full rounded-full {store.barColor}" style="width: {store.pct}%"></div>
					</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Index Management Tools -->
	<section class="glass-panel mt-8 overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="text-lg font-semibold text-zinc-100">Index Management Tools</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Run this if search results are stale or if you have modified the global extraction
				ontology.
			</p>
		</div>
		<div class="space-y-6 p-6">
			<div
				class="flex flex-col justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 sm:flex-row sm:items-center"
			>
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Re-embed Vector Index</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Re-embeds every extracted chunk with the configured embedding provider. Runs in
						batches and <span class="font-medium text-amber-400">incurs AI token costs</span>.
					</p>
					{#if rebuildProgress}
						<p class="mt-2 text-xs text-zinc-400" role="status">{rebuildProgress}</p>
					{:else if rebuildNotice}
						<p class="mt-2 text-xs text-emerald-400" role="status">{rebuildNotice}</p>
					{/if}
				</div>
				<button
					onclick={() => (confirmOpen = true)}
					disabled={$rebuild.isPending}
					class="flex shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium whitespace-nowrap text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
				>
					<RefreshCw class="h-4 w-4 {$rebuild.isPending ? 'animate-spin' : ''}" />
					{$rebuild.isPending ? 'Re-embedding…' : 'Start Re-embed'}
				</button>
			</div>
		</div>
	</section>
</div>

{#if confirmOpen}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
	>
		<div
			transition:scale={{ duration: 150, start: 0.95 }}
			class="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<AlertTriangle class="h-5 w-5 text-amber-400" /> Re-embed all chunks?
				</h2>
				<button onclick={() => (confirmOpen = false)} class="text-zinc-500 hover:text-zinc-300">
					<X class="h-5 w-5" />
				</button>
			</div>
			<div class="space-y-3 p-5 text-sm text-zinc-300">
				<p>
					This regenerates the embedding for <span class="font-medium text-zinc-100">every
					extracted chunk</span> in your library using your configured AI embedding provider.
				</p>
				<p class="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
					This is a paid operation: each chunk is sent to the embedding API and billed as token
					usage. Large libraries may take several minutes and cost accordingly.
				</p>
			</div>
			<div class="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4 py-3">
				<button
					onclick={() => (confirmOpen = false)}
					class="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
				>
					Cancel
				</button>
				<button
					onclick={startRebuild}
					class="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500"
				>
					Re-embed Now
				</button>
			</div>
		</div>
	</div>
{/if}
