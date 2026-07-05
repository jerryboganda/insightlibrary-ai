<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import { Search, Loader2, BrainCircuit, FileText, FolderOpen, Quote, ArrowRight, ImageIcon, Table2 } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { SearchResult } from '@insightlibrary/schemas';

	let input = $state('');
	let submitted = $state('');
	let activeTab = $state<'all' | 'figures'>('all');

	// Real backend search: FTS + pgvector RRF on Postgres, substring in-memory.
	const results = $derived(
		createQuery({
			queryKey: ['search', submitted],
			queryFn: () => api.search(submitted),
			enabled: submitted.length > 0 && activeTab === 'all'
		})
	);

	// Figure/table retrieval: extracted figure & table doc_blocks (caption/markdown search).
	const figures = $derived(
		createQuery({
			queryKey: ['search-figures', submitted],
			queryFn: () => api.searchFigures(submitted),
			enabled: submitted.length > 0 && activeTab === 'figures'
		})
	);

	// The /api/figures response carries documentId + title but not folderId, so
	// resolve each unique parent document to build /folders/{folderId}/{docId} links.
	const figureDocIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const f of $figures.data ?? []) ids.add(f.documentId);
		return [...ids].sort();
	});
	const figureDocs = $derived(
		createQuery({
			queryKey: ['search-figure-docs', figureDocIds],
			queryFn: async () => {
				const docs = await Promise.all(
					figureDocIds.map((id) => api.getDocument(id).catch(() => null))
				);
				const byId: Record<string, string> = {};
				for (const d of docs) if (d) byId[d.id] = d.folderId;
				return byId;
			},
			enabled: figureDocIds.length > 0
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

	const tabs = [
		{ id: 'all', label: 'All Results', icon: Search },
		{ id: 'figures', label: 'Figures & Tables', icon: Table2 }
	] as const;
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
		<div class="mt-6 flex border-b border-zinc-800">
			{#each tabs as tab (tab.id)}
				<button
					onclick={() => (activeTab = tab.id)}
					class={cn(
						'relative flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
						activeTab === tab.id ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
					)}
				>
					<tab.icon class="h-4 w-4" /> {tab.label}
				</button>
			{/each}
		</div>

		{#if activeTab === 'all'}
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
		{:else}
			<div class="mt-8 space-y-8">
				{#if $figures.isFetching}
					<div class="flex items-center gap-2 text-sm text-zinc-500">
						<Loader2 class="h-4 w-4 animate-spin" /> Searching extracted figures & tables…
					</div>
				{:else if $figures.isError}
					<div class="rounded-xl border border-dashed border-rose-900/50 py-16 text-center text-sm text-rose-400">
						Figure search failed. Try again.
					</div>
				{:else if ($figures.data?.length ?? 0) === 0}
					<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">
						No figures or tables match "{submitted}".
					</div>
				{:else}
					<div class="text-xs text-zinc-500">
						{$figures.data?.length} extracted {($figures.data?.length ?? 0) === 1 ? 'block' : 'blocks'} ·
						<span class="font-mono text-emerald-400">doc_blocks</span> visual retrieval
					</div>
					<section in:fly={{ y: 8, duration: 150 }} class="space-y-2">
						{#each $figures.data ?? [] as f (f.id)}
							{@const folderId = $figureDocs.data?.[f.documentId]}
							<Card class="p-4">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2">
											{#if f.kind === 'table'}
												<span class="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400"><Table2 class="h-3 w-3" /> Table</span>
											{:else}
												<span class="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400"><ImageIcon class="h-3 w-3" /> Figure</span>
											{/if}
											<span class="text-[11px] text-zinc-500">Page {f.page}</span>
										</div>
										{#if f.kind === 'table'}
											<div class="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
												<pre class="font-mono text-xs whitespace-pre leading-relaxed text-zinc-300">{f.content}</pre>
											</div>
										{:else}
											<p class="mt-2 text-xs leading-relaxed text-zinc-300">{f.content}</p>
										{/if}
										<div class="mt-2">
											{#if folderId}
												<a
													href="/folders/{folderId}/{f.documentId}"
													class="inline-flex items-center gap-1.5 text-xs text-indigo-400 transition-colors hover:text-indigo-300"
												>
													<FileText class="h-3.5 w-3.5" /> {f.title} <ArrowRight class="h-3 w-3" />
												</a>
											{:else}
												<span class="inline-flex items-center gap-1.5 text-xs text-zinc-500">
													<FileText class="h-3.5 w-3.5" /> {f.title}
													{#if $figureDocs.isFetching}<Loader2 class="h-3 w-3 animate-spin" />{/if}
												</span>
											{/if}
										</div>
									</div>
								</div>
							</Card>
						{/each}
					</section>
				{/if}
			</div>
		{/if}
	{/if}
</div>
