<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import { Sparkles, ListTree, ChevronRight, Link2, AlertTriangle, BookOpen, FileText } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { TopicSection, DeltaEntry } from '@insightlibrary/schemas';

	// Reader is a live view over the canonical SSOT: pick a topic, read its
	// verified claims with citations, and see conflicts flagged from the delta feed.
	const topicsQuery = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });
	let selectedTopicId = $state<string | null>(null);
	const topicId = $derived(selectedTopicId ?? $topicsQuery.data?.[0]?.id ?? null);
	const topicQuery = $derived(
		createQuery({
			queryKey: ['topic', topicId],
			queryFn: () => api.getTopic(topicId as string),
			enabled: !!topicId
		})
	);

	const topic = $derived($topicQuery.data?.topic);
	const sections = $derived<TopicSection[]>((topic?.sections as TopicSection[]) ?? []);
	const delta = $derived<DeltaEntry[]>($topicQuery.data?.delta ?? []);
	const conflicts = $derived(delta.filter((d) => d.type === 'conflict'));

	let activeSectionId = $state<string | null>(null);
	const activeSection = $derived(sections.find((s) => s.id === activeSectionId) ?? sections[0]);

	// Reset the active section when the topic changes.
	$effect(() => {
		void topicId;
		activeSectionId = null;
	});

	function citationText(citations: string[]): string {
		// Interleaved [sourceRef, locator, …] → "sourceRef locator" chips.
		const out: string[] = [];
		for (let i = 0; i < citations.length; i += 2) {
			const ref = citations[i];
			const loc = citations[i + 1];
			if (ref) out.push([ref, loc].filter(Boolean).join(' '));
		}
		return out.join(' · ') || 'uncited';
	}
</script>

<div class="-m-6 flex h-[calc(100vh-4rem)] overflow-hidden">
	<!-- Left: topic + section outline -->
	<aside class="hidden w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/40 lg:flex">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
			<ListTree class="h-4 w-4 text-indigo-400" />
			<span class="text-sm font-medium text-zinc-300">SSOT Outline</span>
		</div>
		<div class="border-b border-zinc-800 p-2">
			<select
				bind:value={selectedTopicId}
				class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
			>
				{#each $topicsQuery.data ?? [] as t (t.id)}
					<option value={t.id}>{t.name}</option>
				{/each}
			</select>
		</div>
		<div class="flex-1 overflow-y-auto p-2">
			{#if $topicQuery.isLoading}
				{#each Array(5) as _, i (i)}<Skeleton class="mb-1 h-8 rounded-md" />{/each}
			{:else}
				{#each sections as section (section.id)}
					<button
						onclick={() => (activeSectionId = section.id)}
						class={cn(
							'group flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
							activeSection?.id === section.id
								? 'bg-indigo-500/10 text-indigo-300'
								: 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
						)}
					>
						<span class="truncate">{section.title}</span>
						<span class="ml-2 shrink-0 font-mono text-[10px] text-zinc-600">{section.claims.length}</span>
					</button>
				{/each}
			{/if}
		</div>
		<div class="border-t border-zinc-800 px-4 py-3 text-[11px] text-zinc-600">
			{topic?.name ?? 'No topic selected'}
		</div>
	</aside>

	<!-- Center: reading pane -->
	<main class="relative flex-1 overflow-y-auto bg-[#0a0a0c] p-6 md:p-10">
		{#if $topicQuery.isLoading}
			<div class="mx-auto max-w-3xl space-y-4">
				<Skeleton class="h-10 w-2/3 rounded" />
				{#each Array(6) as _, i (i)}<Skeleton class="h-4 rounded" />{/each}
			</div>
		{:else if !topic}
			<div class="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
				<FileText class="h-8 w-8 text-zinc-600" />
				<p class="text-sm">No canonical topics yet. Ingest sources to build the SSOT.</p>
			</div>
		{:else}
			<div
				in:fade={{ duration: 200 }}
				class="relative mx-auto min-h-full max-w-3xl rounded-sm border border-zinc-800 bg-zinc-950/80 p-8 font-serif text-lg leading-relaxed text-zinc-300 shadow-2xl md:p-12"
			>
				<h1 class="mb-6 border-b border-zinc-800 pb-4 font-sans text-3xl font-bold text-zinc-100">
					{topic.name}
				</h1>
				{#if activeSection}
					<h2 class="mt-2 mb-4 font-sans text-xl font-semibold text-zinc-200">{activeSection.title}</h2>
					{#each activeSection.claims as claim (claim.id)}
						<p class="mb-5">
							{claim.content}
							<span class="ml-1 align-super font-sans text-[10px] font-medium text-indigo-400">
								[{citationText(claim.citations)}]
							</span>
						</p>
					{:else}
						<p class="text-sm text-zinc-500">No claims in this section yet.</p>
					{/each}
				{/if}
				<div class="mt-12 flex items-center justify-between border-t border-zinc-800 pt-6 font-sans text-sm text-zinc-500">
					<span>Health {topic.health}%</span>
					<span class="italic">{topic.updates} updates</span>
				</div>
			</div>
		{/if}
	</main>

	<!-- Right: extracted claims + conflicts -->
	<aside class="hidden w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/40 xl:flex">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
			<Sparkles class="h-4 w-4 text-indigo-400" />
			<span class="text-sm font-medium text-zinc-300">Section Claims</span>
			<span class="ml-auto font-mono text-[10px] text-zinc-600">{activeSection?.claims.length ?? 0}</span>
		</div>
		<div class="flex-1 space-y-3 overflow-y-auto p-4">
			{#if conflicts.length}
				<div class="rounded-md border border-rose-500/20 bg-rose-500/10 p-3">
					<div class="flex items-center gap-1.5 text-xs font-medium text-rose-300">
						<AlertTriangle class="h-3.5 w-3.5" /> {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} flagged
					</div>
				</div>
			{/if}
			{#each activeSection?.claims ?? [] as claim (claim.id)}
				<Card class="p-3">
					<p class="text-[13px] leading-relaxed text-zinc-300">{claim.content}</p>
					<div class="mt-2 flex items-center gap-1.5">
						<Link2 class="h-3 w-3 text-zinc-600" />
						<span class="font-mono text-[10px] text-zinc-500">{citationText(claim.citations)}</span>
					</div>
				</Card>
			{:else}
				<div class="flex flex-col items-center gap-2 py-10 text-center text-zinc-600">
					<BookOpen class="h-6 w-6" />
					<p class="text-xs">Select a section with claims.</p>
				</div>
			{/each}
		</div>
		<div class="border-t border-zinc-800 p-4">
			<a
				href="/review"
				class="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-indigo-500/40 hover:text-indigo-300"
			>
				<span>Open the review queue</span>
				<ChevronRight class="h-3.5 w-3.5" />
			</a>
		</div>
	</aside>
</div>
