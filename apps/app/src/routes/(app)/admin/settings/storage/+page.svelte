<script lang="ts">
	import { HardDrive, Database, Network, Server, RefreshCw, AlertTriangle, X } from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';

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

	// Real storage figures from GET /api/admin/storage-stats (gap C7):
	// table sizes via pg_total_relation_size, counts from the live tables, S3
	// usage from ListObjectsV2 (server-cached ~5 min). Nothing is invented — when
	// a source is unavailable the card says so.
	const statsQuery = createQuery({
		queryKey: ['storage-stats'],
		queryFn: () => api.getStorageStats(),
		staleTime: 60_000
	});

	function fmtBytes(bytes: number | null | undefined): string {
		if (bytes === null || bytes === undefined) return '—';
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = bytes / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
	}

	function fmtCount(n: number | null | undefined): string {
		if (n === null || n === undefined) return '—';
		if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
		if (n >= 10_000) return `${Math.round(n / 1000)}k`;
		return n.toLocaleString();
	}

	interface StoreCard {
		id: string;
		label: string;
		icon: typeof Database;
		iconColor: string;
		barColor: string;
		value: string;
		unit: string;
		sub: string;
		/** null → no meaningful ratio exists; the bar is hidden (no fake %). */
		pct: number | null;
	}

	const stores = $derived.by<StoreCard[]>(() => {
		const s = $statsQuery.data;
		if (!s) return [];
		const chunks = s.counts.chunks;
		const embedded = s.counts.embeddedChunks;
		const embeddedPct =
			chunks !== null && embedded !== null && chunks > 0
				? Math.round((embedded / chunks) * 100)
				: null;
		return [
			{
				id: 'vector',
				label: 'Vector Database (chunks)',
				icon: Database,
				iconColor: 'text-emerald-400',
				barColor: 'bg-emerald-400',
				value: fmtBytes(s.database?.tables.chunks),
				unit: '',
				sub:
					chunks !== null && embedded !== null
						? `${fmtCount(embedded)} of ${fmtCount(chunks)} chunks embedded`
						: 'no database connected',
				pct: embeddedPct
			},
			{
				id: 'graph',
				label: 'Knowledge Graph',
				icon: Network,
				iconColor: 'text-indigo-400',
				barColor: 'bg-indigo-400',
				value: fmtCount(s.counts.graphNodes),
				unit: ' nodes',
				sub:
					s.counts.graphEdges !== null
						? `${fmtCount(s.counts.graphEdges)} edges · ${fmtBytes(
								(s.database?.tables.graphNodes ?? 0) + (s.database?.tables.graphEdges ?? 0)
							)}`
						: 'no database connected',
				pct: null
			},
			{
				id: 'object',
				label: 'Object Storage (source files)',
				icon: HardDrive,
				iconColor: 'text-purple-400',
				barColor: 'bg-purple-400',
				value: s.s3.configured ? fmtBytes(s.s3.bytes) : 'Not configured',
				unit: '',
				sub: s.s3.configured
					? s.s3.objects !== null
						? `${fmtCount(s.s3.objects)} object${s.s3.objects === 1 ? '' : 's'}${s.s3.truncated ? ' (partial scan)' : ''}`
						: 'usage unavailable'
					: 'set S3_* env to enable',
				pct: null
			},
			{
				id: 'database',
				label: 'Postgres Database',
				icon: Server,
				iconColor: 'text-amber-400',
				barColor: 'bg-amber-400',
				value: fmtBytes(s.database?.totalBytes),
				unit: '',
				sub:
					s.counts.documents !== null
						? `${fmtCount(s.counts.documents)} documents · ${fmtCount(s.counts.docBlocks)} blocks`
						: 'running on the in-memory seed repo',
				pct: null
			}
		];
	});
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

	<!-- Storage Overview — real numbers from /api/admin/storage-stats -->
	{#if $statsQuery.isLoading}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
			{#each ['a', 'b', 'c', 'd'] as k (k)}
				<Skeleton class="h-36 w-full rounded-xl" />
			{/each}
		</div>
	{:else if $statsQuery.isError}
		<div
			class="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-5 text-sm text-rose-300"
		>
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
			<p>Failed to load storage statistics. Admin access is required for this page.</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
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
						<div class="mb-2 flex items-end justify-between gap-2">
							<span class="text-2xl font-bold text-zinc-100"
								>{store.value}<span class="text-sm font-normal text-zinc-500">{store.unit}</span></span
							>
							<span class="text-right text-xs font-medium text-zinc-500">{store.sub}</span>
						</div>
						{#if store.pct !== null}
							<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
								<div class="h-full rounded-full {store.barColor}" style="width: {store.pct}%"></div>
							</div>
							<p class="mt-1 text-right text-[10px] text-zinc-600">{store.pct}% embedded</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		{#if $statsQuery.data?.source === 'memory'}
			<p class="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
				Running on the in-memory seed repository — connect Postgres for real storage statistics.
			</p>
		{/if}
	{/if}

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
