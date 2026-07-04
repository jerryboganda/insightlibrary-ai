<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import {
		Tag,
		Download,
		Plus,
		Scale,
		Building2,
		HeartPulse,
		Network,
		X,
		Clock
	} from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { Ontology } from '@insightlibrary/schemas';

	// Live domain ontologies from the real API. The schema carries a compact shape
	// (id/name/entities/relations/status/lastUpdated). The prototype presents each
	// domain as a richly styled card (icon, accent, sample-entity tags, footer note),
	// so each row is decorated with deterministic presentation-only detail keyed by
	// id/name — no per-domain visual metadata endpoint exists yet (prototype spec).
	const ontologies = createQuery({ queryKey: ['ontologies'], queryFn: () => api.listOntologies() });

	type Decor = {
		icon: typeof Tag;
		iconClass: string;
		tags: string[];
		footerNote?: string;
	};

	// Match the three canonical domains from the prototype; fall back to a neutral
	// indigo treatment for any additional ontologies returned by the API.
	const DECOR: Record<string, Decor> = {
		medical: {
			icon: HeartPulse,
			iconClass: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
			tags: ['Disease', 'Pathology', 'Etiology', 'Treatment'],
			footerNote: 'Default for "USMLE Prep"'
		},
		legal: {
			icon: Scale,
			iconClass: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
			tags: ['Statute', 'Precedent', 'Judgment', 'Evidence']
		},
		sop: {
			icon: Building2,
			iconClass: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
			tags: ['Policy', 'Procedure', 'Control', 'Exception']
		}
	};

	const FALLBACK: Decor = {
		icon: Network,
		iconClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
		tags: ['Entity', 'Property', 'Relation']
	};

	const DESCRIPTIONS: Record<string, string> = {
		medical: 'Standardized schema for diseases, drugs, anatomy, and clinical pearls.',
		legal: 'Extraction targets for statutes, precedents, exceptions, and arguments.',
		sop: 'Standard operational protocols, rules, outputs, and compliance controls.'
	};

	function decorKey(o: Ontology): string {
		const s = `${o.id} ${o.name}`.toLowerCase();
		if (s.includes('medical') || s.includes('clinical')) return 'medical';
		if (s.includes('legal') || s.includes('case law') || s.includes('law')) return 'legal';
		if (s.includes('sop') || s.includes('enterprise') || s.includes('operational')) return 'sop';
		return 'fallback';
	}

	function decorFor(o: Ontology): Decor {
		const k = decorKey(o);
		return DECOR[k] ?? FALLBACK;
	}

	function descFor(o: Ontology): string {
		const k = decorKey(o);
		return (
			DESCRIPTIONS[k] ??
			`Semantic relationship schema and SSOT sectioning template for the ${o.name} discipline.`
		);
	}

	// Sample-entity chips: show the domain's canonical tags, then a "+ N more" chip
	// reflecting the real entity count from the API when it exceeds the shown tags.
	function tagsFor(o: Ontology): string[] {
		const base = decorFor(o).tags;
		const remaining = o.entities - base.length;
		return remaining > 0 ? [...base, `+ ${remaining} more`] : base;
	}

	let isNewOpen = $state(false);
	let isImportOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let importJson = $state('');

	const importPlaceholder = `{
  "name": "Custom Schema",
  "entities": [
    {
      "id": "e_1",
      "name": "Topic",
      "properties": []
    }
  ]
}`;
</script>

<main class="relative w-full overflow-y-auto">
	<div class="mx-auto max-w-5xl space-y-8">
		<header class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
			<div>
				<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
					<Tag class="h-6 w-6 text-indigo-400" />
					Domain Ontologies
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Configure SSOT sectioning templates and semantic relationship schemas per discipline.
				</p>
			</div>
			<div class="flex gap-3">
				<button
					onclick={() => (isImportOpen = true)}
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 focus:ring-1 focus:ring-zinc-700 focus:outline-none"
				>
					<Download class="h-4 w-4" /> Import Schema
				</button>
				<button
					onclick={() => (isNewOpen = true)}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				>
					<Plus class="h-4 w-4" /> New Ontology
				</button>
			</div>
		</header>

		{#if $ontologies.isLoading}
			<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-64 rounded-xl" />
				{/each}
			</div>
		{:else if ($ontologies.data ?? []).length === 0}
			<div
				in:fade
				class="glass-panel flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 px-6 py-20 text-center"
			>
				<div
					class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-500"
				>
					<Tag class="h-6 w-6" />
				</div>
				<h3 class="text-base font-semibold text-zinc-200">No ontologies yet</h3>
				<p class="mt-1 max-w-sm text-sm text-zinc-500">
					Create a domain ontology to define how the SSOT engine sections and relates extracted
					knowledge.
				</p>
				<button
					onclick={() => (isNewOpen = true)}
					class="mt-5 flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
				>
					<Plus class="h-4 w-4" /> New Ontology
				</button>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
				{#each $ontologies.data ?? [] as o, i (o.id)}
					{@const decor = decorFor(o)}
					{@const Icon = decor.icon}
					<a in:fly={{ y: 10, duration: 250, delay: i * 50 }} href={`/admin/ontology/${o.id}`} class="flex">
						<div
							class="group glass-panel flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border-zinc-800 transition-colors hover:border-indigo-500/50"
						>
							<div class="flex-1 p-6 transition-colors hover:bg-zinc-900/20">
								<div
									class={cn(
										'mb-4 flex h-12 w-12 items-center justify-center rounded-xl border transition-transform group-hover:scale-110',
										decor.iconClass
									)}
								>
									<Icon class="h-6 w-6" />
								</div>
								<h3 class="mb-2 text-lg font-bold text-zinc-100">{o.name}</h3>
								<p class="mb-4 line-clamp-2 text-sm text-zinc-400">{descFor(o)}</p>
								<div class="flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
									{#each tagsFor(o) as tag (tag)}
										<span class="rounded border border-zinc-800 bg-zinc-900 px-2 py-1">{tag}</span>
									{/each}
								</div>
							</div>
							<div
								class="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/50 px-6 py-3"
							>
								{#if decor.footerNote}
									<span class="text-xs font-medium text-zinc-500">{decor.footerNote}</span>
								{:else}
									<span class="flex items-center gap-1 text-xs text-zinc-600">
										<Clock class="h-3 w-3" /> Updated {o.lastUpdated}
									</span>
								{/if}
								<span class="text-xs font-medium text-indigo-400 group-hover:underline">
									Edit Schema
								</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</main>

<!-- New Ontology Modal -->
{#if isNewOpen}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) isNewOpen = false;
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Create New Domain Ontology</h2>
			</div>
			<div class="space-y-4 p-6">
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-300" for="new-ont-name">Ontology Name</label>
					<input
						id="new-ont-name"
						type="text"
						bind:value={newName}
						placeholder="e.g. Financial Intelligence"
						class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
					/>
				</div>
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-300" for="new-ont-desc">Description</label>
					<textarea
						id="new-ont-desc"
						bind:value={newDescription}
						placeholder="Describe the purpose of this schema..."
						class="h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
					></textarea>
				</div>
			</div>
			<div class="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 p-4">
				<button
					onclick={() => (isNewOpen = false)}
					class="px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
				>
					Cancel
				</button>
				<button
					onclick={() => (isNewOpen = false)}
					class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
				>
					Create Schema
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Import Schema Modal -->
{#if isImportOpen}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) isImportOpen = false;
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Import Ontology JSON Schema</h2>
				<button
					onclick={() => (isImportOpen = false)}
					class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="p-6">
				<textarea
					bind:value={importJson}
					placeholder={importPlaceholder}
					class="h-64 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 font-mono text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
				></textarea>
			</div>
			<div class="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 p-4">
				<button
					onclick={() => (isImportOpen = false)}
					class="px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
				>
					Cancel
				</button>
				<button
					onclick={() => (isImportOpen = false)}
					class="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
				>
					Import &amp; Validate
				</button>
			</div>
		</div>
	</div>
{/if}
