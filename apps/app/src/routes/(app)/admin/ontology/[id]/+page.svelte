<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		Plus,
		Save,
		Network,
		Tag,
		Trash2,
		ShieldAlert,
		AlignLeft,
		AlignJustify,
		RefreshCw,
		Hash,
		ArrowRightLeft,
		Loader2
	} from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { cn } from '$lib/utils';

	// Resolve the ontology header from the live API by route id so the editor shows
	// the real domain name and active/draft status. The per-entity schema (entities,
	// properties, conflict strategy, test extraction) has no dedicated endpoint yet,
	// so it is inlined below with the prototype's shape/content (prototype spec).
	const id = $derived(page.params.id);
	const ontologies = createQuery({ queryKey: ['ontologies'], queryFn: () => api.listOntologies() });
	const ontology = $derived(($ontologies.data ?? []).find((o) => o.id === id));

	// Derive a readable domain title even before the API resolves (or when the id is
	// one of the prototype's canonical slugs).
	const isMedical = $derived(id === 'medical' || (ontology?.name ?? '').toLowerCase().includes('medical'));
	const domainTitle = $derived(
		ontology?.name ?? (isMedical ? 'Medical & Clinical' : 'Legal Case Law')
	);
	const status = $derived(ontology?.status ?? 'active');

	// ── Inlined schema-editor data (prototype spec — no per-entity endpoint) ────
	type Entity = { id: string; name: string; color: string; active: boolean };
	let entities = $state<Entity[]>([
		{
			id: 'ent_1',
			name: 'Disease / Condition',
			color: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
			active: true
		},
		{
			id: 'ent_2',
			name: 'Treatment / Intervention',
			color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
			active: false
		},
		{
			id: 'ent_3',
			name: 'Diagnostic Test',
			color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
			active: false
		},
		{
			id: 'ent_4',
			name: 'Pathogen',
			color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
			active: false
		}
	]);

	type Property = { id: string; name: string; type: string; required: boolean; desc: string };
	const properties: Property[] = [
		{ id: 'prop_1', name: 'ICD-10 Code', type: 'String', required: true, desc: 'Standard billing code' },
		{
			id: 'prop_2',
			name: 'Etiology',
			type: 'Rich Text',
			required: true,
			desc: 'Underlying causes and origins'
		},
		{
			id: 'prop_3',
			name: 'Risk Factors',
			type: 'List (String)',
			required: false,
			desc: 'Pre-disposing conditions'
		},
		{
			id: 'prop_4',
			name: 'Severity Levels',
			type: 'Enum',
			required: false,
			desc: 'Mild, Moderate, Severe'
		},
		{
			id: 'prop_5',
			name: 'Complications',
			type: 'Relationship (Disease)',
			required: false,
			desc: 'Associated conditions'
		}
	];

	function typeIcon(type: string) {
		switch (type) {
			case 'String':
			case 'List (String)':
				return AlignLeft;
			case 'Rich Text':
				return AlignJustify;
			case 'Enum':
				return Tag;
			case 'Relationship (Disease)':
				return ArrowRightLeft;
			default:
				return Hash;
		}
	}

	function selectEntity(entityId: string) {
		entities = entities.map((e) => ({ ...e, active: e.id === entityId }));
	}

	// Auto-merge strategy toggle for the active entity.
	let mergeStrategy = $state<'append' | 'review'>('append');

	const sourceText =
		"Graves' disease is an immune system disorder that results in the overproduction of thyroid hormones (hyperthyroidism). Although a number of disorders may result in hyperthyroidism, Graves' disease is a common cause. Common signs and symptoms include anxiety and irritability, a fine tremor of the hands or fingers, heat sensitivity...";
	let testText = $state(sourceText);

	const simulatedJson = `{
  "entity": "Disease",
  "name": "Graves' disease",
  "confidence": 0.98,
  "properties": {
    "Etiology": "Immune system disorder resulting in overproduction of thyroid hormones.",
    "Risk Factors": null,
    "Complications": ["hyperthyroidism"]
  }
}`;
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Editor header -->
	<div
		class="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 backdrop-blur-sm"
	>
		<div class="flex items-center gap-4">
			<a
				href="/admin/ontology"
				class="-ml-2 rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
			>
				<ArrowLeft class="h-4 w-4" />
			</a>
			<div class="h-4 w-px bg-zinc-800"></div>
			<div>
				<h1 class="flex items-center gap-2 text-lg font-bold text-zinc-100">
					{#if $ontologies.isLoading}
						<Loader2 class="h-4 w-4 animate-spin text-zinc-500" />
						<span class="text-zinc-500">Loading schema…</span>
					{:else}
						{domainTitle} Schema
						<span
							class={cn(
								'rounded border px-2 py-0.5 text-[10px] font-medium capitalize',
								status === 'active'
									? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
									: 'border-amber-500/20 bg-amber-500/10 text-amber-400'
							)}
						>
							{status}
						</span>
					{/if}
				</h1>
			</div>
		</div>

		<div class="flex items-center gap-3">
			<button
				class="px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
			>
				Discard Changes
			</button>
			<button
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
			>
				<Save class="h-4 w-4" /> Publish Schema
			</button>
		</div>
	</div>

	<div class="flex flex-1 overflow-hidden">
		<!-- Left sidebar — Entities list -->
		<div class="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/30">
			<div
				class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4"
			>
				<h3 class="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
					Entities / Classes
				</h3>
				<button
					class="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
					aria-label="Add entity"
				>
					<Plus class="h-4 w-4" />
				</button>
			</div>
			<div class="flex-1 space-y-2 overflow-y-auto p-4">
				{#each entities as entity (entity.id)}
					{@const dot = entity.color.split(' ')}
					<button
						onclick={() => selectEntity(entity.id)}
						class={cn(
							'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors',
							entity.active
								? 'border-zinc-700 bg-zinc-900'
								: 'border-transparent bg-transparent hover:border-zinc-800 hover:bg-zinc-900/50'
						)}
					>
						<div class="flex items-center gap-2">
							<div class={cn('h-2.5 w-2.5 rounded-sm border', dot[0], dot[2])}></div>
							<span
								class={cn('text-sm font-medium', entity.active ? 'text-zinc-100' : 'text-zinc-300')}
							>
								{entity.name}
							</span>
						</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Main area — Builder -->
		<div class="flex-1 overflow-y-auto bg-zinc-950/20 p-6 md:p-8">
			<div class="mx-auto max-w-4xl space-y-8">
				<!-- Entity detail header -->
				<div
					in:fly={{ y: 8, duration: 250 }}
					class="glass-panel flex items-start justify-between rounded-xl border-zinc-800 p-6"
				>
					<div class="flex gap-4">
						<div
							class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400"
						>
							<Network class="h-6 w-6" />
						</div>
						<div>
							<h2
								class="inline-block border-b border-dashed border-zinc-700 bg-transparent text-xl font-bold text-zinc-100 transition-colors hover:border-zinc-500 focus:border-indigo-500 focus:outline-none"
							>
								Disease / Condition
							</h2>
							<p class="mt-2 text-sm text-zinc-400">
								A core medical condition, disorder, or physiological state. This entity represents the
								root document cluster in the SSOT.
							</p>

							<div class="mt-4 flex flex-wrap gap-2">
								<span
									class="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300"
								>
									ID: ent_disease
								</span>
								<span
									class="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300"
								>
									Extraction Strategy: Deep Paragraph
								</span>
							</div>
						</div>
					</div>
					<button
						class="rounded-md border border-transparent p-2 text-rose-400 transition-colors hover:border-rose-500/20 hover:bg-rose-500/10"
						aria-label="Delete entity"
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>

				<!-- Properties table -->
				<div>
					<div class="mb-4 flex items-center justify-between">
						<h3 class="text-lg font-semibold text-zinc-100">Schema Properties</h3>
						<button
							class="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600"
						>
							<Plus class="h-4 w-4" /> Add Property
						</button>
					</div>

					<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
						<div class="overflow-x-auto">
							<table class="w-full text-left text-sm whitespace-nowrap">
								<thead
									class="border-b border-zinc-800 bg-zinc-900/50 text-xs tracking-wider text-zinc-400"
								>
									<tr>
										<th class="px-4 py-3 font-medium">Property Name</th>
										<th class="px-4 py-3 font-medium">Data Type</th>
										<th class="px-4 py-3 font-medium">Required</th>
										<th class="px-4 py-3 font-medium">Extraction Prompt / Instruction</th>
										<th class="px-4 py-3 text-right font-medium"></th>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-800/50">
									{#each properties as p (p.id)}
										{@const TypeIcon = typeIcon(p.type)}
										<tr class="hover:bg-zinc-900/30">
											<td class="px-4 py-3">
												<span class="font-medium text-zinc-200">{p.name}</span>
												<div class="mt-0.5 font-mono text-[10px] text-zinc-500">{p.id}</div>
											</td>
											<td class="px-4 py-3">
												<div
													class="inline-flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-300"
												>
													<TypeIcon class="h-3.5 w-3.5" />
													{p.type}
												</div>
											</td>
											<td class="px-4 py-3">
												{#if p.required}
													<span
														class="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-400"
													>
														Yes
													</span>
												{:else}
													<span class="text-xs font-medium text-zinc-500">No</span>
												{/if}
											</td>
											<td
												class="max-w-[200px] truncate px-4 py-3 text-xs text-zinc-400"
												title={p.desc}
											>
												{p.desc}
											</td>
											<td class="px-4 py-3 text-right">
												<button class="p-1 text-zinc-500 hover:text-zinc-300" aria-label="Property options">
													...
												</button>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</div>

				<!-- Conflict resolution settings -->
				<div class="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-6">
					<h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-200">
						<ShieldAlert class="h-4 w-4 text-amber-400" /> Auto-Merge Strategy
					</h3>
					<p class="mb-4 max-w-2xl text-xs text-zinc-400">
						When conflicting data is extracted for this entity across different documents, how should
						the SSOT engine resolve it?
					</p>

					<div class="flex max-w-sm shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
						<button
							onclick={() => (mergeStrategy = 'append')}
							class={cn(
								'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
								mergeStrategy === 'append'
									? 'bg-zinc-800 text-zinc-200 shadow'
									: 'text-zinc-500 hover:text-zinc-300'
							)}
						>
							Append as Variants
						</button>
						<button
							onclick={() => (mergeStrategy = 'review')}
							class={cn(
								'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
								mergeStrategy === 'review'
									? 'bg-zinc-800 text-zinc-200 shadow'
									: 'text-zinc-500 hover:text-zinc-300'
							)}
						>
							Require Human Review
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Right sidebar — Test extraction -->
		<div class="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/30">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
				<h3 class="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
					Test Extraction
				</h3>
				<button
					class="flex items-center gap-1 text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
				>
					<RefreshCw class="h-3 w-3" /> Run Test
				</button>
			</div>
			<div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
				<div class="flex flex-1 flex-col">
					<label class="mb-2 text-xs font-medium text-zinc-400" for="test-source">Source Text</label>
					<textarea
						id="test-source"
						bind:value={testText}
						placeholder="Paste sample document text here to test the extraction schema..."
						class="w-full flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 p-3 font-serif text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none"
					></textarea>
				</div>
				<div class="flex h-48 flex-col border-t border-zinc-800 pt-4">
					<span class="mb-2 text-xs font-medium text-zinc-400">Simulated JSON Output</span>
					<div
						class="flex-1 overflow-y-auto rounded-md border border-zinc-800 bg-[#0d0d0d] p-3"
					>
						<pre
							class="font-mono text-[10px] break-all whitespace-pre-wrap text-emerald-400/80">{simulatedJson}</pre>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
