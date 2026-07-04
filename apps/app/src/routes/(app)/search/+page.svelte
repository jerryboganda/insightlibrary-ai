<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import { Search, Loader2, BrainCircuit, FileText, FolderOpen, Quote, ArrowRight } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { SearchResult } from '@insightlibrary/schemas';

	let input = $state('');
	let submitted = $state('');

	// Real backend search: FTS + pgvector RRF on Postgres, substring in-memory.
	const results = $derived(
		createQuery({
			queryKey: ['search', submitted],
			queryFn: () => api.search(submitted),
			enabled: submitted.length > 0
		})
	);

	function run() {
		submitted = input.trim();
	}

	const groups = $derived.by(() => {
		const data = $results.data?.results ?? [];
		const by = (k: SearchResult['kind']) => data.filter((r) => r.kind === k);
		return {
			topic: by('topic'),
			chunk: by('chunk'),
			document: by('document'),
			folder: by('folder')
		};
	});

	const kindMeta = {
		topic: { icon: BrainCircuit, label: 'Canonical Topics (SSOT)', tone: 'text-indigo-400' },
		chunk: { icon: Quote, label: 'Source Citations & Exact Chunks', tone: 'text-emerald-400' },
		document: { icon: FileText, label: 'Documents', tone: 'text-amber-400' },
		folder: { icon: FolderOpen, label: 'Domain Folders', tone: 'text-zinc-400' }
	} as const;
</script>

<div class={cn('mx-auto max-w-3xl transition-all', submitted ? 'pt-2' : 'flex min-h-[70vh] flex-col justify-center')}>
	{#if !submitted}
		<div in:fade class="mb-8 text-center">
			<div class="mb-4 inline-flex rounded-xl bg-indigo-500/10 p-3 text-indigo-400"><Search class="h-7 w-7" /></div>
			<h1 class="glow-text text-3xl font-bold tracking-tight text-zinc-100">Hybrid Knowledge Search</h1>
			<p class="mt-2 text-sm text-zinc-500">
				Dense embeddings + BM25 + GraphRAG, fused with Reciprocal Rank Fusion across your single source of truth.
			</p>
		</div>
	{/if}

	<form onsubmit={(e) => { e.preventDefault(); run(); }} class="relative">
		<div class="pointer-events-none absolute inset-0 rounded-xl bg-indigo-500/10 blur-xl"></div>
		<div class="relative flex items-center rounded-xl border border-zinc-800 bg-zinc-950 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50">
			<Search class="ml-4 h-5 w-5 text-zinc-500" />
			<input
				bind:value={input}
				placeholder="Search across all books, graphs, and canonical topics..."
				class="w-full border-none bg-transparent py-4 pr-4 pl-3 text-zinc-200 placeholder:text-zinc-600 focus:ring-0 focus:outline-none"
			/>
			<button type="submit" class="mr-2 rounded-lg bg-indigo-600 p-2 text-white transition-colors hover:bg-indigo-500" aria-label="Search">
				<ArrowRight class="h-4 w-4" />
			</button>
		</div>
	</form>

	{#if submitted}
		<div class="mt-8 space-y-8">
			{#if $results.isFetching}
				<div class="flex items-center gap-2 text-sm text-zinc-500">
					<Loader2 class="h-4 w-4 animate-spin" /> Applying dense embeddings · reranking · querying graph…
				</div>
			{:else if ($results.data?.total ?? 0) === 0}
				<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">No results for "{submitted}".</div>
			{:else}
				<div class="text-xs text-zinc-500">
					{$results.data?.total} results ·
					<span class="font-mono text-indigo-400">{$results.data?.mode === 'hybrid' ? 'FTS + vector (RRF)' : 'lexical'}</span> ranking
				</div>
				{#each Object.entries(groups) as [kind, items] (kind)}
					{#if items.length}
						{@const meta = kindMeta[kind as SearchResult['kind']]}
						<section in:fly={{ y: 8, duration: 150 }} class="space-y-3">
							<h2 class={cn('flex items-center gap-2 text-sm font-medium', meta.tone)}><meta.icon class="h-4 w-4" /> {meta.label}</h2>
							<div class="space-y-2">
								{#each items as r (r.id)}
									<a href={r.href}>
										<Card hover class="p-4">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0">
													<div class="truncate text-sm font-medium text-zinc-100">{r.title}</div>
													<p class="mt-1 line-clamp-2 text-xs text-zinc-400">{r.snippet}</p>
												</div>
												<ArrowRight class="mt-1 h-4 w-4 shrink-0 text-zinc-600" />
											</div>
										</Card>
									</a>
								{/each}
							</div>
						</section>
					{/if}
				{/each}
			{/if}
		</div>
	{/if}
</div>
