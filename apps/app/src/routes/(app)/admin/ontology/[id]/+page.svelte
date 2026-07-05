<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
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
		Loader2,
		AlertCircle
	} from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { cn } from '$lib/utils';

	const queryClient = useQueryClient();
	const id = $derived(page.params.id ?? '');

	// Real ontology schema from the DB (B23): live per-kind concept counts + sample
	// concepts/synonyms from the dictionary, overlaid with any saved editable layer.
	// No hardcoded entities/properties — the editor now reflects the source of truth.
	const schemaQuery = $derived(
		createQuery({ queryKey: ['ontology-schema', id], queryFn: () => api.getOntologySchema(id) })
	);
	const view = $derived($schemaQuery.data);

	const domainTitle = $derived(view?.name ?? 'Ontology');
	const status = $derived(view?.status ?? 'draft');

	// ── Editable working state (hydrated from the server view) ──────────────────
	type Property = { id: string; name: string; type: string; required: boolean; desc: string };
	type Entity = { id: string; name: string; mergeStrategy: 'append' | 'review'; properties: Property[] };

	let entities = $state<Entity[]>([]);
	let activeId = $state<string | null>(null);
	let dirty = $state(false);
	// Signature of the last-loaded server snapshot, so we hydrate exactly once per
	// fetch (and re-hydrate after a save) without clobbering in-progress edits.
	let loadedSig = $state('');

	function cloneEntities(src: Entity[]): Entity[] {
		return src.map((e) => ({ ...e, properties: e.properties.map((p) => ({ ...p })) }));
	}

	$effect(() => {
		const v = $schemaQuery.data;
		if (!v) return;
		const sig = `${v.id}:${v.updatedAt ?? 'none'}:${v.stored}`;
		if (sig === loadedSig) return;
		loadedSig = sig;
		const next = cloneEntities(v.schema.entities as Entity[]);
		entities = next;
		activeId = next[0]?.id ?? null;
		dirty = false;
	});

	const activeEntity = $derived(entities.find((e) => e.id === activeId) ?? entities[0]);
	// Real sample concepts for the selected entity's kind (entity id is `ent_<kind>`).
	const activeKind = $derived(activeEntity?.id.startsWith('ent_') ? activeEntity.id.slice(4) : null);
	const activeKindSummary = $derived(
		(view?.conceptKinds ?? []).find((k) => k.kind === activeKind)
	);

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
		activeId = entityId;
	}

	let entityCounter = $state(0);
	function addEntity() {
		entityCounter += 1;
		const newId = `ent_custom_${entityCounter}`;
		entities = [...entities, { id: newId, name: 'New Entity', mergeStrategy: 'append', properties: [] }];
		activeId = newId;
		dirty = true;
	}
	function deleteEntity(entityId: string) {
		if (!confirm('Delete this entity and its schema?')) return;
		const remaining = entities.filter((e) => e.id !== entityId);
		entities = remaining;
		if (activeId === entityId) activeId = remaining[0]?.id ?? null;
		dirty = true;
	}

	function setMergeStrategy(strategy: 'append' | 'review') {
		if (!activeEntity) return;
		entities = entities.map((e) => (e.id === activeEntity.id ? { ...e, mergeStrategy: strategy } : e));
		dirty = true;
	}

	// ── Property editing (on the active entity) ─────────────────────────────────
	let openMenu = $state<string | null>(null);
	function toggleMenu(propId: string) {
		openMenu = openMenu === propId ? null : propId;
	}
	let propCounter = $state(0);
	function addProperty() {
		if (!activeEntity) return;
		propCounter += 1;
		const prop: Property = { id: `prop_new_${propCounter}`, name: 'New Property', type: 'String', required: false, desc: '' };
		entities = entities.map((e) =>
			e.id === activeEntity.id ? { ...e, properties: [...e.properties, prop] } : e
		);
		dirty = true;
	}
	function deleteProperty(propId: string) {
		if (!activeEntity) return;
		if (!confirm('Delete this property? This cannot be undone until you discard changes.')) return;
		entities = entities.map((e) =>
			e.id === activeEntity.id ? { ...e, properties: e.properties.filter((p) => p.id !== propId) } : e
		);
		openMenu = null;
		dirty = true;
	}
	function toggleRequired(propId: string) {
		if (!activeEntity) return;
		entities = entities.map((e) =>
			e.id === activeEntity.id
				? { ...e, properties: e.properties.map((p) => (p.id === propId ? { ...p, required: !p.required } : p)) }
				: e
		);
		openMenu = null;
		dirty = true;
	}

	// ── Notices ─────────────────────────────────────────────────────────────────
	let notice = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	function flashNotice(msg: string) {
		notice = msg;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 3000);
	}

	function discardChanges() {
		if (!view) return;
		entities = cloneEntities(view.schema.entities as Entity[]);
		activeId = entities[0]?.id ?? null;
		openMenu = null;
		dirty = false;
		flashNotice('Changes discarded');
	}

	// ── Publish (PUT /api/ontologies/[id]/schema) ───────────────────────────────
	const publishMut = createMutation({
		mutationFn: () =>
			api.saveOntologySchema(id, {
				name: view?.name,
				status: 'active',
				schema: { entities }
			}),
		onSuccess: (saved) => {
			// Re-seed the cache from the server's canonical view and re-hydrate.
			queryClient.setQueryData(['ontology-schema', id], saved);
			loadedSig = '';
			dirty = false;
			flashNotice('Schema published');
			queryClient.invalidateQueries({ queryKey: ['ontologies'] });
		}
	});

	function errMsg(e: unknown): string {
		return e instanceof Error ? e.message : 'Request failed';
	}

	// ── Test extraction (POST /api/ontology/test) ───────────────────────────────
	// Runs real entity linking over the sample text and shows genuine resolutions.
	const sampleSeed =
		"Graves' disease is an immune system disorder that results in the overproduction of thyroid hormones (hyperthyroidism). Common signs and symptoms include anxiety and irritability, a fine tremor of the hands, and heat sensitivity.";
	let testText = $state(sampleSeed);

	type TestEntity = {
		mention: string;
		conceptId: string;
		prefLabel: string;
		ontology: string;
		score: number;
		match: 'exact' | 'semantic';
	};
	type TestResponse = { mentionsTested: number; linkedCount: number; entities: TestEntity[]; unmatched: string[] };
	let testResult = $state<TestResponse | null>(null);

	const testMut = createMutation({
		mutationFn: (text: string) => api.testOntology(text),
		onSuccess: (res: TestResponse) => {
			testResult = res;
			flashNotice(`Linked ${res.linkedCount} of ${res.mentionsTested} mentions`);
		}
	});

	function runTest() {
		const text = testText.trim();
		if (!text) return;
		testResult = null;
		$testMut.reset();
		$testMut.mutate(text);
	}

	const testJson = $derived(testResult ? JSON.stringify(testResult.entities, null, 2) : '');
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
					{#if $schemaQuery.isLoading}
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
						{#if view}
							<span class="text-xs font-normal text-zinc-500">
								{view.conceptTotal} concepts · {view.synonymTotal} synonyms
							</span>
						{/if}
					{/if}
				</h1>
			</div>
		</div>

		<div class="flex items-center gap-3">
			{#if notice}
				<span
					in:fly={{ x: 8, duration: 200 }}
					class="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400"
				>
					{notice}
				</span>
			{:else if $publishMut.isError}
				<span class="flex items-center gap-1 text-xs font-medium text-rose-400">
					<AlertCircle class="h-3.5 w-3.5" />
					{errMsg($publishMut.error)}
				</span>
			{:else if dirty}
				<span class="text-xs font-medium text-amber-400">Unsaved changes</span>
			{/if}
			<button
				onclick={discardChanges}
				disabled={!dirty || $publishMut.isPending}
				class="px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-40"
			>
				Discard Changes
			</button>
			<button
				onclick={() => $publishMut.mutate()}
				disabled={$publishMut.isPending || !view}
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:opacity-50"
			>
				{#if $publishMut.isPending}
					<Loader2 class="h-4 w-4 animate-spin" /> Publishing…
				{:else}
					<Save class="h-4 w-4" /> Publish Schema
				{/if}
			</button>
		</div>
	</div>

	<div class="flex flex-1 overflow-hidden">
		<!-- Left sidebar — Entities list -->
		<div class="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/30">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
				<h3 class="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Entities / Classes</h3>
				<button
					onclick={addEntity}
					class="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
					aria-label="Add entity"
				>
					<Plus class="h-4 w-4" />
				</button>
			</div>
			<div class="flex-1 space-y-2 overflow-y-auto p-4">
				{#if $schemaQuery.isLoading}
					<div class="space-y-2">
						{#each Array(4) as _, i (i)}
							<div class="h-10 animate-pulse rounded-lg bg-zinc-900"></div>
						{/each}
					</div>
				{:else if entities.length === 0}
					<p class="px-1 py-4 text-xs text-zinc-500">
						No entity classes yet. This ontology has no loaded concepts — import
						concepts, or add an entity class to define its schema.
					</p>
				{:else}
					{#each entities as entity (entity.id)}
						<button
							onclick={() => selectEntity(entity.id)}
							class={cn(
								'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors',
								entity.id === activeEntity?.id
									? 'border-zinc-700 bg-zinc-900'
									: 'border-transparent bg-transparent hover:border-zinc-800 hover:bg-zinc-900/50'
							)}
						>
							<div class="flex items-center gap-2">
								<div class="h-2.5 w-2.5 rounded-sm border border-indigo-500/40 bg-indigo-500/20"></div>
								<span
									class={cn(
										'text-sm font-medium',
										entity.id === activeEntity?.id ? 'text-zinc-100' : 'text-zinc-300'
									)}
								>
									{entity.name}
								</span>
							</div>
							{#if entity.properties.length}
								<span class="font-mono text-[10px] text-zinc-500">{entity.properties.length}</span>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Main area — Builder -->
		<div class="flex-1 overflow-y-auto bg-zinc-950/20 p-6 md:p-8">
			<div class="mx-auto max-w-4xl space-y-8">
				{#if activeEntity}
					<!-- Entity detail header -->
					<div
						in:fly={{ y: 8, duration: 250 }}
						class="glass-panel flex items-start justify-between rounded-xl border-zinc-800 p-6"
					>
						<div class="flex gap-4">
							<div
								class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-400"
							>
								<Network class="h-6 w-6" />
							</div>
							<div>
								<h2 class="text-xl font-bold text-zinc-100">{activeEntity.name}</h2>
								<p class="mt-2 text-sm text-zinc-400">
									{#if activeKindSummary}
										{activeKindSummary.count} concept{activeKindSummary.count === 1 ? '' : 's'} of kind
										<span class="font-mono text-zinc-300">{activeKindSummary.kind}</span> in the loaded dictionary.
									{:else}
										A custom entity class. Define its extraction properties and merge policy below.
									{/if}
								</p>

								<div class="mt-4 flex flex-wrap gap-2">
									<span
										class="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300"
									>
										ID: {activeEntity.id}
									</span>
									{#if activeKindSummary}
										{#each activeKindSummary.samples.slice(0, 3) as s (s.id)}
											<span
												class="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-400"
												title={s.synonyms.length ? `synonyms: ${s.synonyms.join(', ')}` : undefined}
											>
												{s.prefLabel}
											</span>
										{/each}
									{/if}
								</div>
							</div>
						</div>
						<button
							onclick={() => deleteEntity(activeEntity.id)}
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
								onclick={addProperty}
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
										{#if activeEntity.properties.length === 0}
											<tr>
												<td colspan="5" class="px-4 py-8 text-center text-xs text-zinc-500">
													No properties defined. Add one to shape what the SSOT engine extracts for this entity.
												</td>
											</tr>
										{/if}
										{#each activeEntity.properties as p (p.id)}
											{@const TypeIcon = typeIcon(p.type)}
											<tr class="hover:bg-zinc-900/30">
												<td class="px-4 py-3">
													<input
														value={p.name}
														oninput={(e) => {
															const val = e.currentTarget.value;
															entities = entities.map((en) =>
																en.id === activeEntity.id
																	? { ...en, properties: en.properties.map((x) => (x.id === p.id ? { ...x, name: val } : x)) }
																	: en
															);
															dirty = true;
														}}
														class="w-full border-b border-dashed border-transparent bg-transparent font-medium text-zinc-200 transition-colors hover:border-zinc-700 focus:border-indigo-500 focus:outline-none"
													/>
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
												<td class="max-w-[220px] px-4 py-3">
													<input
														value={p.desc}
														oninput={(e) => {
															const val = e.currentTarget.value;
															entities = entities.map((en) =>
																en.id === activeEntity.id
																	? { ...en, properties: en.properties.map((x) => (x.id === p.id ? { ...x, desc: val } : x)) }
																	: en
															);
															dirty = true;
														}}
														placeholder="Extraction instruction…"
														class="w-full truncate border-b border-dashed border-transparent bg-transparent text-xs text-zinc-400 transition-colors hover:border-zinc-700 focus:border-indigo-500 focus:outline-none"
													/>
												</td>
												<td class="relative px-4 py-3 text-right">
													<button
														onclick={() => toggleMenu(p.id)}
														aria-haspopup="menu"
														aria-expanded={openMenu === p.id}
														class="p-1 text-zinc-500 hover:text-zinc-300"
														aria-label="Property options"
													>
														...
													</button>
													{#if openMenu === p.id}
														<div
															in:fly={{ y: -4, duration: 150 }}
															class="absolute top-full right-4 z-10 mt-1 w-40 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 shadow-xl"
														>
															<button
																onclick={() => toggleRequired(p.id)}
																class="block w-full px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-900"
															>
																Toggle Required
															</button>
															<button
																onclick={() => deleteProperty(p.id)}
																class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-rose-400 transition-colors hover:bg-rose-500/10"
															>
																<Trash2 class="h-3.5 w-3.5" /> Delete Property
															</button>
														</div>
													{/if}
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
								onclick={() => setMergeStrategy('append')}
								class={cn(
									'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
									activeEntity.mergeStrategy === 'append'
										? 'bg-zinc-800 text-zinc-200 shadow'
										: 'text-zinc-500 hover:text-zinc-300'
								)}
							>
								Append as Variants
							</button>
							<button
								onclick={() => setMergeStrategy('review')}
								class={cn(
									'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
									activeEntity.mergeStrategy === 'review'
										? 'bg-zinc-800 text-zinc-200 shadow'
										: 'text-zinc-500 hover:text-zinc-300'
								)}
							>
								Require Human Review
							</button>
						</div>
					</div>
				{:else if !$schemaQuery.isLoading}
					<div
						class="glass-panel flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 px-6 py-20 text-center"
					>
						<Network class="mb-3 h-8 w-8 text-zinc-600" />
						<h3 class="text-base font-semibold text-zinc-200">No entity classes yet</h3>
						<p class="mt-1 max-w-sm text-sm text-zinc-500">
							This ontology has no loaded concepts to derive classes from. Import concepts from the
							ontology list, or add an entity class to start defining a schema.
						</p>
						<button
							onclick={addEntity}
							class="mt-5 flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
						>
							<Plus class="h-4 w-4" /> Add Entity Class
						</button>
					</div>
				{/if}
			</div>
		</div>

		<!-- Right sidebar — Test extraction -->
		<div class="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/30">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
				<h3 class="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Test Extraction</h3>
				<button
					onclick={runTest}
					disabled={$testMut.isPending}
					class="flex items-center gap-1 text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300 disabled:opacity-50"
				>
					{#if $testMut.isPending}
						<Loader2 class="h-3 w-3 animate-spin" />
					{:else}
						<RefreshCw class="h-3 w-3" />
					{/if}
					Run Test
				</button>
			</div>
			<div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
				<div class="flex flex-1 flex-col">
					<label class="mb-2 text-xs font-medium text-zinc-400" for="test-source">Source Text</label>
					<textarea
						id="test-source"
						bind:value={testText}
						placeholder="Paste sample document text here to test entity linking…"
						class="w-full flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 p-3 font-serif text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none"
					></textarea>
					<p class="mt-2 text-[10px] text-zinc-600">
						Runs real ontology linking (exact synonym match, then embedding nearest-neighbour) over
						candidate mentions in the text.
					</p>
				</div>

				{#if $testMut.isError}
					<div class="rounded-md border border-rose-900/50 bg-rose-950/20 p-3 text-xs text-rose-300">
						{errMsg($testMut.error)}
					</div>
				{:else if testResult}
					<div in:fly={{ y: 6, duration: 200 }} class="border-t border-zinc-800 pt-4">
						<span class="mb-2 block text-xs font-medium text-zinc-400">
							Linked Entities ({testResult.linkedCount}/{testResult.mentionsTested})
						</span>
						{#if testResult.entities.length}
							<div class="space-y-1.5">
								{#each testResult.entities as ent (ent.conceptId + ent.mention)}
									<div class="rounded border border-indigo-500/20 bg-indigo-500/5 px-2 py-1.5">
										<div class="flex items-center justify-between gap-2">
											<span class="truncate text-[11px] font-medium text-zinc-200">{ent.mention}</span>
											<span
												class={cn(
													'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
													ent.match === 'exact'
														? 'bg-emerald-500/10 text-emerald-400'
														: 'bg-amber-500/10 text-amber-400'
												)}
											>
												{ent.match} · {ent.score.toFixed(2)}
											</span>
										</div>
										<div class="mt-0.5 truncate font-mono text-[10px] text-indigo-300">
											{ent.prefLabel} <span class="text-zinc-600">({ent.ontology})</span>
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-zinc-500">
								No mentions resolved to a concept. Load an ontology whose concepts cover this text, or
								check that embeddings are configured.
							</p>
						{/if}
						{#if testResult.unmatched.length}
							<p class="mt-2 text-[10px] text-zinc-600">
								Unmatched: {testResult.unmatched.slice(0, 8).join(', ')}{testResult.unmatched.length > 8 ? '…' : ''}
							</p>
						{/if}
					</div>
				{/if}

				<div class="flex h-48 flex-col border-t border-zinc-800 pt-4">
					<span class="mb-2 text-xs font-medium text-zinc-400">Linked-Entity JSON</span>
					<div class="flex-1 overflow-y-auto rounded-md border border-zinc-800 bg-[#0d0d0d] p-3">
						{#if testJson}
							<pre
								class="font-mono text-[10px] break-all whitespace-pre-wrap text-emerald-400/80">{testJson}</pre>
						{:else}
							<p class="font-mono text-[10px] text-zinc-600">
								// Run a test to see the real linked-entity output.
							</p>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
