<script lang="ts">
	import { HardDrive, Database, Network, RefreshCw } from '@lucide/svelte';
	import { fly } from 'svelte/transition';

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
				Run these tools if search results are stale or if you have modified the global extraction
				ontology.
			</p>
		</div>
		<div class="space-y-6 p-6">
			<div
				class="flex flex-col justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 sm:flex-row sm:items-center"
			>
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Rebuild Vector Index</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Re-embeds all extracted chunks using the latest BGE-M3 embedding models. This process will
						incur token costs.
					</p>
				</div>
				<button
					class="flex shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium whitespace-nowrap text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					<RefreshCw class="h-4 w-4" /> Start Rebuild
				</button>
			</div>

			<div
				class="flex flex-col justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 sm:flex-row sm:items-center"
			>
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Clear Semantic Cache</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Forces Copilot SDK and orchestrator agents to re-fetch context instead of using cached
						SSOT responses.
					</p>
				</div>
				<button
					class="flex shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium whitespace-nowrap text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					Clear Cache
				</button>
			</div>
		</div>
	</section>
</div>
