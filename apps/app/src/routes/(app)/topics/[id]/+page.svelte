<script lang="ts">
	import { page } from '$app/state';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, scale } from 'svelte/transition';
	import {
		BrainCircuit,
		HeartPulse,
		BadgeCheck,
		Layers,
		GitMerge,
		History,
		FileText,
		CheckCircle2,
		MessageSquareWarning,
		Plus,
		X,
		Trash2,
		RefreshCw
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { iconByName } from '$lib/icons';
	import { cn } from '$lib/utils';
	import type { CoverageCell } from '@insightlibrary/schemas';

	const id = $derived(page.params.id ?? '');
	const query = $derived(createQuery({ queryKey: ['topic', id], queryFn: () => api.getTopic(id) }));
	const qc = useQueryClient();

	let activeTab = $state<'ssot' | 'coverage' | 'delta' | 'history'>('ssot');

	// New claims persist to the SSOT via the API, then the topic query refetches.
	const addClaim = createMutation({
		mutationFn: (input: { sectionId: string; content: string; citations: string[] }) =>
			api.addClaim(id, input),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['topic', id] })
	});
	// Evidence-only recompose + verifier gate → writes a new topic version.
	const regenerate = createMutation({
		mutationFn: () => api.regenerateTopic(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['topic', id] })
	});
	let modalSection = $state<string | null>(null);
	let claimText = $state('');
	let citations = $state<string[]>([]);
	let citeInput = $state('');

	const tabs = [
		{ id: 'ssot', label: 'Canonical SSOT', icon: FileText },
		{ id: 'coverage', label: 'Source Coverage Matrix', icon: Layers },
		{ id: 'delta', label: 'Delta Intel Feed', icon: GitMerge },
		{ id: 'history', label: 'Version History', icon: History }
	] as const;

	const sourceIds = ['bk-A', 'bk-B', 'bk-C', 'bk-D'];

	function openModal(sectionId: string) {
		modalSection = sectionId;
		claimText = '';
		citations = [];
		citeInput = '';
	}
	function addCitation() {
		if (citeInput.trim()) {
			citations = [...citations, citeInput.trim()];
			citeInput = '';
		}
	}
	function saveClaim() {
		if (!claimText.trim() || !modalSection) return;
		$addClaim.mutate({ sectionId: modalSection, content: claimText.trim(), citations });
		modalSection = null;
	}

	const cellClass = (c: CoverageCell) =>
		c === 'Strong'
			? 'text-emerald-400 font-semibold'
			: c === 'Medium'
				? 'text-amber-400'
				: c === 'Weak'
					? 'text-rose-400'
					: 'text-zinc-600';
</script>

{#if $query.isLoading}
	<div class="mx-auto max-w-5xl space-y-4"><Skeleton class="h-12 w-80" /><Skeleton class="h-64" /></div>
{:else if $query.data}
	{@const topic = $query.data.topic}
	{@const coverage = $query.data.coverage}
	{@const delta = $query.data.delta}
	<div class="-m-6 flex flex-col">
		<!-- Hero -->
		<div class="relative overflow-hidden border-b border-zinc-800 bg-zinc-950/30 px-6 py-8 md:px-10">
			<div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(79,70,229,0.1),transparent_60%)]"></div>
			<div class="relative mx-auto flex max-w-5xl items-start justify-between">
				<div>
					<div class="mb-2 flex items-center gap-3">
						<div class="rounded-md bg-indigo-500/20 p-1.5 text-indigo-400"><BrainCircuit class="h-5 w-5" /></div>
						<span class="font-mono text-xs tracking-wider text-zinc-500 uppercase">SSOT Canonical Topic</span>
					</div>
					<h1 class="glow-text mb-2 text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">{topic.name}</h1>
					<div class="flex flex-wrap items-center gap-2">
						{#each topic.aliases as alias (alias)}
							<span class="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">AKA: {alias}</span>
						{/each}
					</div>
				</div>
				<div class="flex items-center gap-4 text-right">
					<div class="flex flex-col items-end">
						<span class="mb-1 text-xs font-medium text-zinc-500">Completeness Score</span>
						<span class="text-3xl font-bold text-emerald-400">{topic.health}%</span>
					</div>
					<div class="h-12 w-px bg-zinc-800"></div>
					<div class="text-left">
						<p class="mb-1 font-mono text-[10px] text-zinc-500">CONTRIBUTING SOURCES</p>
						<div class="flex -space-x-2">
							{#each sourceIds as sid (sid)}
								<div class="flex h-7 w-7 items-center justify-center rounded-full border-2 border-zinc-950 bg-zinc-800 text-[10px] font-bold text-zinc-300" title={sid}>{sid.split('-')[1]}</div>
							{/each}
						</div>
					</div>
				</div>
			</div>

			<div class="mx-auto mt-8 flex max-w-5xl border-b border-zinc-800">
				{#each tabs as tab (tab.id)}
					<button
						onclick={() => (activeTab = tab.id)}
						class={cn(
							'relative flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
							activeTab === tab.id ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
						)}
					>
						<tab.icon class="h-4 w-4" /> {tab.label}
						{#if tab.id === 'delta'}<span class="ml-1 h-2 w-2 rounded-full bg-indigo-500"></span>{/if}
					</button>
				{/each}
			</div>
		</div>

		<div class="p-6 md:p-10">
			<div class="mx-auto max-w-5xl">
				{#if activeTab === 'ssot'}
					<div in:fade={{ duration: 150 }} class="space-y-8">
						<div class="flex items-center justify-between">
							<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-200"><HeartPulse class="h-5 w-5 text-indigo-400" /> Topic Master File</h2>
							<div class="flex items-center gap-2">
								<a href="/study/{topic.id}" class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"><BrainCircuit class="h-3.5 w-3.5" /> Study Topic</a>
								<button onclick={() => $regenerate.mutate()} disabled={$regenerate.isPending} class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"><RefreshCw class={`h-3.5 w-3.5 ${$regenerate.isPending ? 'animate-spin' : ''}`} /> {$regenerate.isPending ? 'Composing…' : 'Regenerate'}</button>
								<button onclick={() => $regenerate.mutate()} disabled={$regenerate.isPending} class="flex items-center gap-1.5 rounded-md border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:opacity-50"><BadgeCheck class="h-3.5 w-3.5" /> Verify Evidence</button>
							</div>
						</div>

						{#if topic.sections && topic.sections.length}
							<div class="space-y-6">
								{#each topic.sections as section (section.id)}
									{@const Icon = iconByName(section.icon)}
									{@const claims = section.claims}
									<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
										<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-4 py-3">
											<div class="flex items-center gap-3">
												<div class="rounded bg-zinc-800/80 p-1.5 text-zinc-400"><Icon class="h-4 w-4" /></div>
												<h3 class="font-medium text-zinc-200">{section.title}</h3>
											</div>
											<button onclick={() => openModal(section.id)} class="flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-indigo-300"><Plus class="h-3.5 w-3.5" /> Add Claim</button>
										</div>
										<div class="space-y-3 p-4">
											{#each claims as claim (claim.id)}
												<div class="group flex items-start gap-3">
													<span class="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500"></span>
													<p class="flex-1 text-sm leading-relaxed text-zinc-300">{claim.content}</p>
													<div class="flex max-w-[150px] flex-wrap justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
														{#each claim.citations as cite (cite)}
															<span class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-zinc-400 transition-colors hover:border-indigo-500/50 hover:text-indigo-300">{cite}</span>
														{/each}
													</div>
												</div>
											{/each}
											{#if claims.length === 0}<p class="text-sm text-zinc-500 italic">No claims added to this section yet.</p>{/if}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">This topic's SSOT is still being assembled.</div>
						{/if}
					</div>
				{:else if activeTab === 'coverage'}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header><h2 class="text-lg font-semibold text-zinc-200">Source Coverage Matrix</h2><p class="mt-1 text-sm text-zinc-500">Which sources contribute to specific aspects of this topic.</p></header>
						<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
							<div class="overflow-x-auto">
								<table class="w-full text-left text-sm">
									<thead class="border-b border-zinc-800 bg-zinc-900/50 font-mono text-xs text-zinc-400">
										<tr>
											<th class="px-4 py-3 font-medium">Topic Aspect</th>
											{#each sourceIds as sid (sid)}<th class="border-l border-zinc-800/50 px-4 py-3 font-medium">{sid}</th>{/each}
											<th class="border-l border-zinc-800 bg-zinc-900 px-4 py-3 font-medium">SSOT Status</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
										{#each coverage as row (row.aspect)}
											<tr class="transition-colors hover:bg-zinc-900/30">
												<td class="px-4 py-3 font-medium text-zinc-200">{row.aspect}</td>
												<td class="border-l border-zinc-800/50 px-4 py-3 text-xs {cellClass(row.bA)}">{row.bA === 'None' ? '--' : row.bA}</td>
												<td class="border-l border-zinc-800/50 px-4 py-3 text-xs {cellClass(row.bB)}">{row.bB === 'None' ? '--' : row.bB}</td>
												<td class="border-l border-zinc-800/50 px-4 py-3 text-xs {cellClass(row.bC)}">{row.bC === 'None' ? '--' : row.bC}</td>
												<td class="border-l border-zinc-800/50 px-4 py-3 text-xs {cellClass(row.bD)}">{row.bD === 'None' ? '--' : row.bD}</td>
												<td class="border-l border-zinc-800 bg-zinc-900/30 px-4 py-3">
													<span class={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs', row.status === 'Covered' ? 'text-emerald-400' : row.status === 'Improved' ? 'text-indigo-400' : 'border border-rose-500/20 bg-rose-500/10 text-rose-400')}>
														{#if row.status === 'Covered'}<CheckCircle2 class="h-3.5 w-3.5" />{:else if row.status === 'Improved'}<GitMerge class="h-3.5 w-3.5" />{:else}<MessageSquareWarning class="h-3.5 w-3.5" />{/if}
														{row.status}
													</span>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					</div>
				{:else if activeTab === 'delta'}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header><h2 class="text-lg font-semibold text-zinc-200">Delta Knowledge Extract</h2><p class="mt-1 text-sm text-zinc-500">Found upon recent ingestion of <span class="font-mono text-indigo-300">Book D: Board Pearls</span></p></header>
						<div class="space-y-4">
							{#each delta as d (d.id)}
								<div class="glass-panel flex items-start gap-4 rounded-xl border border-zinc-800 p-4">
									<div class={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', d.type === 'duplicate' ? 'bg-zinc-800 text-zinc-400' : d.type === 'citation' ? 'bg-emerald-500/20 text-emerald-400' : d.type === 'expand' ? 'bg-blue-500/20 text-blue-400' : d.type === 'new' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-rose-500/20 text-rose-400')}>
										{#if d.type === 'conflict'}<MessageSquareWarning class="h-4 w-4" />{:else}<GitMerge class="h-4 w-4" />{/if}
									</div>
									<div>
										<h4 class="font-medium text-zinc-200">{d.text}</h4>
										<p class="mt-1 text-sm text-zinc-500">{d.details}</p>
										{#if d.type === 'conflict'}<a href="/review" class="mt-3 inline-block rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20">Review Conflicts in Queue →</a>{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div in:fade={{ duration: 150 }} class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">
						Version history is recorded per SSOT merge. The latest canonical version is v1.2.
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if modalSection}
		<div transition:fade={{ duration: 150 }} class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
			<div transition:scale={{ duration: 150, start: 0.95 }} class="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
				<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
					<h2 class="text-lg font-semibold text-zinc-100">Add Claim & Reference</h2>
					<button onclick={() => (modalSection = null)} class="text-zinc-500 hover:text-zinc-300"><X class="h-5 w-5" /></button>
				</div>
				<div class="space-y-5 p-5">
					<div>
						<label for="claim" class="mb-1.5 block text-sm font-medium text-zinc-300">Claim Content</label>
						<textarea id="claim" bind:value={claimText} placeholder="Enter the factual claim to add to the SSOT..." class="h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"></textarea>
					</div>
					<div class="border-t border-zinc-900 pt-2">
						<label for="cite" class="mb-1.5 block text-sm font-medium text-zinc-300">Citations & Source References</label>
						<p class="mb-3 text-xs text-zinc-500">Add supporting citations. E.g., 'bk-A', 'p45'.</p>
						<div class="mb-3 flex gap-2">
							<input id="cite" bind:value={citeInput} onkeydown={(e) => e.key === 'Enter' && addCitation()} placeholder="e.g. bk-B, p104" class="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none" />
							<button onclick={addCitation} disabled={!citeInput.trim()} class="rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50">Add</button>
						</div>
						<div class="flex min-h-[40px] flex-wrap items-start gap-2">
							{#if citations.length === 0}<span class="mt-1 text-xs text-zinc-600 italic">No citations added yet.</span>{:else}
								{#each citations as cite, idx (idx)}
									<div class="inline-flex items-center rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-300">
										<span class="mr-2 font-mono">{cite}</span>
										<button onclick={() => (citations = citations.filter((_, i) => i !== idx))} class="text-indigo-400 hover:text-rose-400"><Trash2 class="h-3 w-3" /></button>
									</div>
								{/each}
							{/if}
						</div>
					</div>
				</div>
				<div class="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4 py-3">
					<button onclick={() => (modalSection = null)} class="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200">Cancel</button>
					<button onclick={saveClaim} disabled={!claimText.trim() || citations.length === 0} class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">Save to SSOT</button>
				</div>
			</div>
		</div>
	{/if}
{:else}
	<div class="py-16 text-center text-zinc-500">Topic not found.</div>
{/if}
