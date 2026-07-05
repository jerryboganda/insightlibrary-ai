<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		ShieldAlert,
		Check,
		X,
		GitMerge,
		MessageSquareWarning,
		ExternalLink,
		Loader2
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	const qc = useQueryClient();
	const review = createQuery({ queryKey: ['review'], queryFn: () => api.listReview() });

	// Track which specific item + decision is mutating so we can show per-button spinners.
	let pending = $state<{ id: string; decision: 'accepted' | 'rejected' } | null>(null);

	// Track which items have their sources panel expanded (client-only toggle).
	let expandedSources = $state<Set<string>>(new Set());
	function toggleSources(id: string) {
		const next = new Set(expandedSources);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedSources = next;
	}

	const resolve = createMutation({
		mutationFn: (vars: { id: string; decision: 'accepted' | 'rejected' }) =>
			api.resolveReview(vars.id, vars.decision),
		onMutate: (vars) => {
			pending = vars;
		},
		onSettled: () => {
			pending = null;
			qc.invalidateQueries({ queryKey: ['review'] });
		}
	});

	// Only pending items belong in the queue view.
	const items = $derived(($review.data ?? []).filter((i) => i.status === 'pending'));
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto max-w-4xl space-y-8">
		<header class="flex items-center justify-between gap-4">
			<div>
				<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
					<ShieldAlert class="h-6 w-6 text-rose-400" />
					Governance Review Queue
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Resolve contradictions and approve novel claims derived from recent ingestion delta.
				</p>
			</div>
			{#if !$review.isLoading}
				<div
					class="flex items-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-400"
				>
					<span class="h-2 w-2 animate-pulse rounded-full bg-rose-500"></span>
					{items.length} Pending Items
				</div>
			{/if}
		</header>

		<div class="space-y-6">
			{#if $review.isLoading}
				{#each Array(2) as _, i (i)}
					<div class="overflow-hidden rounded-xl border border-zinc-800 glass-panel">
						<div class="border-b border-zinc-800 bg-zinc-900/80 px-5 py-3">
							<Skeleton class="h-5 w-56" />
						</div>
						<div class="space-y-4 p-5">
							<Skeleton class="h-28 w-full" />
							<Skeleton class="h-16 w-full" />
						</div>
					</div>
				{/each}
			{:else if $review.isError}
				<div class="rounded-xl border border-rose-900/50 bg-rose-950/20 p-6 text-center">
					<p class="text-sm text-rose-300">Failed to load the review queue. Please try again.</p>
				</div>
			{:else if items.length === 0}
				<div class="py-20 text-center" in:fade={{ duration: 250 }}>
					<ShieldAlert class="mx-auto mb-4 h-12 w-12 text-zinc-700" />
					<h3 class="text-lg font-medium text-zinc-400">Queue is empty</h3>
					<p class="mt-1 text-sm text-zinc-600">All delta knowledge has been reviewed.</p>
				</div>
			{:else}
				{#each items as item, i (item.id)}
					<div
						class="overflow-hidden rounded-xl border border-zinc-800 shadow-lg glass-panel"
						in:fly={{ y: 12, duration: 250, delay: i * 40 }}
					>
						<div
							class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-5 py-3"
						>
							<div class="flex items-center gap-3">
								<div
									class={cn(
										'flex items-center gap-1.5 rounded p-1.5 text-xs font-semibold tracking-wider uppercase',
										item.type === 'conflict'
											? 'bg-rose-500/20 text-rose-400'
											: 'bg-indigo-500/20 text-indigo-400'
									)}
								>
									{#if item.type === 'conflict'}
										<MessageSquareWarning class="h-3.5 w-3.5" />
										conflict
									{:else}
										<GitMerge class="h-3.5 w-3.5" />
										new claim
									{/if}
								</div>
								<span class="font-medium text-zinc-200">Topic: {item.topic}</span>
							</div>
							<span
								class={cn(
									'rounded-full border px-2 py-0.5 text-xs',
									item.confidence === 'High'
										? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
										: 'border-amber-500/20 bg-amber-500/10 text-amber-400'
								)}
							>
								AI Confidence: {item.confidence}
							</span>
						</div>

						<div class="p-5">
							{#if item.type === 'conflict'}
								<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
									<div class="relative rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
										<span
											class="absolute -top-2.5 left-3 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
										>
											Existing SSOT
										</span>
										<p class="mt-2 text-sm font-medium text-zinc-300">"{item.originalClaim}"</p>
										<div
											class="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-500"
										>
											Source:
											<span class="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-indigo-300">
												{item.sourceA}
											</span>
										</div>
									</div>
									<div
										class="relative rounded-lg border border-rose-900/50 bg-rose-950/20 p-4 shadow-[inset_0_0_20px_rgba(225,29,72,0.05)]"
									>
										<span
											class="absolute -top-2.5 left-3 rounded border border-rose-800 bg-rose-900 px-2 py-0.5 text-xs text-rose-300"
										>
											New Extract (Conflict)
										</span>
										<p class="mt-2 text-sm font-medium text-zinc-200">"{item.newClaim}"</p>
										<div
											class="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-500"
										>
											Source:
											<span class="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-indigo-300">
												{item.sourceB}
											</span>
										</div>
									</div>
								</div>
							{:else}
								<div class="relative rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-4">
									<span
										class="absolute -top-2.5 left-3 rounded border border-indigo-800 bg-indigo-900 px-2 py-0.5 text-xs text-indigo-300"
									>
										Novel Knowledge
									</span>
									<p class="mt-2 text-sm leading-relaxed font-medium text-zinc-200">
										"{item.newClaim}"
									</p>
									<div
										class="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-500"
									>
										Source:
										<span class="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-indigo-300">
											{item.sourceB}
										</span>
									</div>
								</div>
							{/if}

							<div class="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
								<h4 class="mb-1 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
									AI Assessment
								</h4>
								<p class="text-sm text-zinc-400">{item.notes}</p>
							</div>

							{#if expandedSources.has(item.id)}
								<div
									in:fly={{ y: -6, duration: 200 }}
									class="mt-4 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
								>
									<h4 class="text-xs font-semibold tracking-wider text-zinc-500 uppercase">
										Sources
									</h4>
									{#if item.type === 'conflict'}
										<div class="flex items-center gap-2 text-xs text-zinc-400">
											<span class="text-zinc-500">Existing SSOT:</span>
											<span class="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-indigo-300">
												{item.sourceA}
											</span>
										</div>
									{/if}
									<div class="flex items-center gap-2 text-xs text-zinc-400">
										<span class="text-zinc-500">New Extract:</span>
										<span class="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-indigo-300">
											{item.sourceB}
										</span>
									</div>
								</div>
							{/if}

							<div class="mt-6 flex items-center justify-end gap-3">
								<button
									onclick={() => toggleSources(item.id)}
									aria-expanded={expandedSources.has(item.id)}
									class="mr-auto flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
								>
									<ExternalLink class="h-3.5 w-3.5" />
									{expandedSources.has(item.id) ? 'Hide Sources' : 'View Sources'}
								</button>
								<button
									onclick={() => $resolve.mutate({ id: item.id, decision: 'rejected' })}
									disabled={$resolve.isPending && pending?.id === item.id}
									class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
								>
									{#if $resolve.isPending && pending?.id === item.id && pending?.decision === 'rejected'}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<X class="h-4 w-4" />
									{/if}
									Reject
								</button>
								<button
									onclick={() => $resolve.mutate({ id: item.id, decision: 'accepted' })}
									disabled={$resolve.isPending && pending?.id === item.id}
									class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500 disabled:opacity-50"
								>
									{#if $resolve.isPending && pending?.id === item.id && pending?.decision === 'accepted'}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Check class="h-4 w-4" />
									{/if}
									Approve &amp; Merge
								</button>
							</div>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</main>
