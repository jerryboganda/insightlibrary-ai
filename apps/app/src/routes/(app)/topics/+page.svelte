<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import { Hash, BookOpen, Search, Filter, MoreHorizontal } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, Skeleton } from '$lib/components/ui';
	import { cn, healthBg } from '$lib/utils';
	import type { Topic } from '@insightlibrary/schemas';

	const topics = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });

	let query = $state('');

	const filtered = $derived.by<Topic[]>(() => {
		const list = $topics.data ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(t) =>
				t.name.toLowerCase().includes(q) ||
				t.folder.toLowerCase().includes(q) ||
				t.aliases.some((a) => a.toLowerCase().includes(q))
		);
	});
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
			<button
				class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
			>
				<Filter class="h-4 w-4" /> Filter
			</button>
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
										{query.trim()
											? `No topics match "${query}".`
											: 'No canonical topics yet. They appear as your documents are indexed.'}
									</p>
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
									<button
										class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
										aria-label="More actions"
									>
										<MoreHorizontal class="h-4 w-4" />
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</div>
</div>
