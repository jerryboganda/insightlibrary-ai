<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import {
		Hash,
		BookOpen,
		Search,
		Filter,
		MoreHorizontal,
		ExternalLink,
		Link as LinkIcon,
		RefreshCw
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn, healthBg } from '$lib/utils';
	import type { Topic } from '@insightlibrary/schemas';

	const queryClient = useQueryClient();
	const topics = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });

	let query = $state('');

	// ── Filters (client-side over the loaded registry) ────────────────────────
	let filterOpen = $state(false);
	let folderFilter = $state('all');
	let healthFilter = $state<'all' | 'high' | 'medium' | 'low'>('all');
	let updatesFilter = $state<'all' | 'pending' | 'none'>('all');

	const folders = $derived.by(() => {
		const set = new Set(($topics.data ?? []).map((t) => t.folder));
		return [...set].sort();
	});

	const activeFilterCount = $derived(
		(folderFilter !== 'all' ? 1 : 0) +
			(healthFilter !== 'all' ? 1 : 0) +
			(updatesFilter !== 'all' ? 1 : 0)
	);

	function clearFilters() {
		folderFilter = 'all';
		healthFilter = 'all';
		updatesFilter = 'all';
	}

	const filtered = $derived.by<Topic[]>(() => {
		let list = $topics.data ?? [];
		const q = query.trim().toLowerCase();
		if (q) {
			list = list.filter(
				(t) =>
					t.name.toLowerCase().includes(q) ||
					t.folder.toLowerCase().includes(q) ||
					t.aliases.some((a) => a.toLowerCase().includes(q))
			);
		}
		if (folderFilter !== 'all') list = list.filter((t) => t.folder === folderFilter);
		if (healthFilter !== 'all') {
			list = list.filter((t) =>
				healthFilter === 'high'
					? t.health >= 90
					: healthFilter === 'medium'
						? t.health >= 70 && t.health < 90
						: t.health < 70
			);
		}
		if (updatesFilter !== 'all') {
			list = list.filter((t) => (updatesFilter === 'pending' ? t.updates > 0 : t.updates === 0));
		}
		return list;
	});

	// ── Per-row actions menu ───────────────────────────────────────────────────
	// The table lives in an overflow-x-auto container which clips absolutely
	// positioned children, so the menu is rendered fixed at the trigger's rect.
	let menuFor = $state<string | null>(null);
	let menuPos = $state({ x: 0, y: 0 });
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	function toggleMenu(e: MouseEvent, id: string) {
		if (menuFor === id) {
			menuFor = null;
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menuPos = { x: rect.right, y: rect.bottom + 4 };
		menuFor = id;
	}

	async function copyLink(id: string) {
		menuFor = null;
		try {
			await navigator.clipboard.writeText(`${window.location.origin}/topics/${id}`);
			copiedId = id;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copiedId = null), 2000);
		} catch {
			// Clipboard unavailable (permissions / insecure context) — nothing to do.
		}
	}

	// Evidence-only recompose + verify for a single topic (existing endpoint).
	const regenerate = createMutation({
		mutationFn: (id: string) => api.regenerateTopic(id),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['topics'] })
	});

	function regenerateRow(id: string) {
		menuFor = null;
		$regenerate.mutate(id);
	}
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
				<Hash class="h-6 w-6 text-indigo-400" />
				Topic Registry
			</h1>
			<p class="mt-1 text-sm text-zinc-400">
				All SSOT canonical topics derived from your library documents.
			</p>
		</div>
		<div class="flex items-center gap-3">
			<div class="relative">
				<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
				<input
					type="text"
					bind:value={query}
					placeholder="Search topics or aliases..."
					class="w-64 rounded-md border border-zinc-800 bg-zinc-950/50 py-2 pr-3 pl-9 text-sm text-zinc-300 focus:border-indigo-500/50 focus:outline-none md:w-80"
				/>
			</div>
			<div class="relative">
				<button
					onclick={() => (filterOpen = !filterOpen)}
					class={cn(
						'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
						activeFilterCount > 0
							? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20'
							: 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
					)}
				>
					<Filter class="h-4 w-4" /> Filter
					{#if activeFilterCount > 0}
						<span
							class="rounded-full bg-indigo-500/20 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300"
						>
							{activeFilterCount}
						</span>
					{/if}
				</button>
				{#if filterOpen}
					<button
						class="fixed inset-0 z-40 cursor-default"
						aria-label="Close filters"
						onclick={() => (filterOpen = false)}
					></button>
					<div
						transition:fade={{ duration: 100 }}
						class="absolute top-full right-0 z-50 mt-2 w-64 rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
					>
						<div class="space-y-4">
							<div>
								<label
									for="filter-folder"
									class="mb-1.5 block text-xs font-medium tracking-wider text-zinc-500 uppercase"
									>Domain Folder</label
								>
								<select
									id="filter-folder"
									bind:value={folderFilter}
									class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
								>
									<option value="all">All folders</option>
									{#each folders as folder (folder)}
										<option value={folder}>{folder}</option>
									{/each}
								</select>
							</div>
							<div>
								<label
									for="filter-health"
									class="mb-1.5 block text-xs font-medium tracking-wider text-zinc-500 uppercase"
									>Completeness</label
								>
								<select
									id="filter-health"
									bind:value={healthFilter}
									class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
								>
									<option value="all">Any</option>
									<option value="high">High (≥ 90%)</option>
									<option value="medium">Medium (70–89%)</option>
									<option value="low">Low (&lt; 70%)</option>
								</select>
							</div>
							<div>
								<label
									for="filter-updates"
									class="mb-1.5 block text-xs font-medium tracking-wider text-zinc-500 uppercase"
									>Pending Updates</label
								>
								<select
									id="filter-updates"
									bind:value={updatesFilter}
									class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
								>
									<option value="all">Any</option>
									<option value="pending">Has pending updates</option>
									<option value="none">Up to date</option>
								</select>
							</div>
							<div class="flex items-center justify-between border-t border-zinc-900 pt-3">
								<button
									onclick={clearFilters}
									disabled={activeFilterCount === 0}
									class="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
								>
									Clear all
								</button>
								<button
									onclick={() => (filterOpen = false)}
									class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
								>
									Done
								</button>
							</div>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</header>

	<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead
					class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
				>
					<tr>
						<th class="px-5 py-4">Canonical Topic</th>
						<th class="px-5 py-4">Known Aliases</th>
						<th class="px-5 py-4">Domain Folder</th>
						<th class="px-5 py-4 text-center">Completeness</th>
						<th class="px-5 py-4 text-center">Pending Updates</th>
						<th class="px-5 py-4">Last Updated</th>
						<th class="px-5 py-4 text-right">Actions</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
					{#if $topics.isLoading}
						{#each Array(6) as _, i (i)}
							<tr>
								<td colspan="7" class="px-5 py-4"><Skeleton class="h-6 w-full" /></td>
							</tr>
						{/each}
					{:else if $topics.isError}
						<tr>
							<td colspan="7" class="px-5 py-12 text-center text-sm text-rose-400">
								Failed to load topics. Please try again.
							</td>
						</tr>
					{:else if filtered.length === 0}
						<tr>
							<td colspan="7" class="px-5 py-16 text-center">
								<div class="mx-auto flex max-w-xs flex-col items-center gap-3 text-zinc-500">
									<div class="rounded-full bg-zinc-900 p-3">
										<BookOpen class="h-6 w-6 text-zinc-600" />
									</div>
									<p class="text-sm">
										{query.trim() || activeFilterCount > 0
											? 'No topics match the current search and filters.'
											: 'No canonical topics yet. They appear as your documents are indexed.'}
									</p>
									{#if activeFilterCount > 0}
										<button
											onclick={clearFilters}
											class="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
										>
											Clear filters
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
						{#each filtered as topic (topic.id)}
							<tr class="group transition-colors hover:bg-zinc-900/40" in:fade={{ duration: 150 }}>
								<td class="px-5 py-4">
									<a
										href="/topics/{topic.id}"
										class="flex items-center gap-2 font-semibold text-zinc-200 transition-colors group-hover:text-indigo-400"
									>
										<BookOpen class="h-4 w-4 text-zinc-500 group-hover:text-indigo-400" />
										{topic.name}
									</a>
								</td>
								<td class="px-5 py-4">
									<div class="flex flex-wrap gap-1">
										{#each topic.aliases as alias (alias)}
											<span
												class="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400"
											>
												{alias}
											</span>
										{:else}
											<span class="text-xs text-zinc-600">—</span>
										{/each}
									</div>
								</td>
								<td class="px-5 py-4 text-sm text-zinc-400">{topic.folder}</td>
								<td class="px-5 py-4">
									<div class="flex items-center justify-center gap-2">
										<div class="h-1.5 w-16 rounded-full border border-zinc-800 bg-zinc-900">
											<div
												class={cn('h-full rounded-full', healthBg(topic.health))}
												style="width: {topic.health}%"
											></div>
										</div>
										<span class="w-6 font-mono text-[10px] text-zinc-500">{topic.health}%</span>
									</div>
								</td>
								<td class="px-5 py-4 text-center">
									{#if topic.updates > 0}
										<span
											class="inline-flex items-center justify-center rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-400"
										>
											{topic.updates}
										</span>
									{:else}
										<span class="text-xs text-zinc-600">-</span>
									{/if}
								</td>
								<td class="px-5 py-4 text-xs text-zinc-500">{topic.lastUpdated}</td>
								<td class="px-5 py-4 text-right">
									<div class="flex items-center justify-end gap-2">
										{#if copiedId === topic.id}
											<span class="text-[10px] font-medium text-emerald-400" role="status"
												>Link copied</span
											>
										{:else if $regenerate.isPending && $regenerate.variables === topic.id}
											<RefreshCw class="h-3.5 w-3.5 animate-spin text-indigo-400" />
										{/if}
										<button
											onclick={(e) => toggleMenu(e, topic.id)}
											class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
											aria-label="More actions for {topic.name}"
											aria-expanded={menuFor === topic.id}
										>
											<MoreHorizontal class="h-4 w-4" />
										</button>
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</div>
</div>

{#if menuFor !== null}
	<button
		class="fixed inset-0 z-40 cursor-default"
		aria-label="Close menu"
		onclick={() => (menuFor = null)}
	></button>
	<div
		transition:fade={{ duration: 100 }}
		class="fixed z-50 w-44 -translate-x-full rounded-lg border border-zinc-800 bg-zinc-950 py-1 shadow-2xl"
		style="left: {menuPos.x}px; top: {menuPos.y}px;"
		role="menu"
	>
		<a
			href="/topics/{menuFor}"
			role="menuitem"
			onclick={() => (menuFor = null)}
			class="flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
		>
			<ExternalLink class="h-4 w-4 text-zinc-500" /> Open topic
		</a>
		<button
			role="menuitem"
			onclick={() => copyLink(menuFor!)}
			class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
		>
			<LinkIcon class="h-4 w-4 text-zinc-500" /> Copy link
		</button>
		<button
			role="menuitem"
			onclick={() => regenerateRow(menuFor!)}
			disabled={$regenerate.isPending}
			class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
		>
			<RefreshCw class="h-4 w-4 text-zinc-500" /> Regenerate SSOT
		</button>
	</div>
{/if}
