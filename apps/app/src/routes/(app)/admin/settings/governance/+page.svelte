<script lang="ts">
	import {
		ShieldAlert,
		GitMerge,
		FileWarning,
		Save,
		Scale,
		GripVertical,
		CheckCircle2,
		Loader2
	} from '@lucide/svelte';
	import { fly, fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';

	// Inline policy config — no governance endpoint yet (prototype spec).
	let ssotConfidence = $state(85);
	let requireReview = $state(true);

	let sources = $state([
		{ id: 's1', name: 'Official Guidelines & Standards', desc: 'e.g., WHO, NIST, IEEE' },
		{ id: 's2', name: 'Latest Edition Textbooks', desc: 'Published within 5 years' },
		{ id: 's3', name: 'Peer-Reviewed Journals', desc: 'Primary research papers' },
		{ id: 's4', name: 'Internal SOPs / Organization Policy', desc: 'Tenant specific' },
		{ id: 's5', name: 'Lecture Notes / Unverified PDFs', desc: 'Lowest priority fallback' }
	]);

	let isSaving = $state(false);
	let showSaved = $state(false);

	function handleSave() {
		isSaving = true;
		setTimeout(() => {
			isSaving = false;
			showSaved = true;
			setTimeout(() => (showSaved = false), 3000);
		}, 1000);
	}

	// Native HTML5 drag-and-drop reordering (replaces framer Reorder).
	let dragIndex = $state<number | null>(null);
	let overIndex = $state<number | null>(null);

	function onDrop(target: number) {
		if (dragIndex === null || dragIndex === target) {
			dragIndex = null;
			overIndex = null;
			return;
		}
		const next = [...sources];
		const [moved] = next.splice(dragIndex, 1);
		next.splice(target, 0, moved);
		sources = next;
		dragIndex = null;
		overIndex = null;
	}
</script>

<div class="max-w-4xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<ShieldAlert class="h-6 w-6 text-indigo-400" />
			Governance & Review Policies
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Configure automation thresholds, manual review requirements, and source prioritization.
		</p>
	</header>

	<!-- Automation Thresholds -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<GitMerge class="h-5 w-5 text-indigo-400" /> Delta Knowledge & Merge Rules
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Determine when the system can automatically update an SSOT vs. requesting human review.
			</p>
		</div>
		<div class="space-y-8 p-6">
			<div class="space-y-4">
				<div class="flex items-end justify-between">
					<div>
						<span class="text-sm font-medium text-zinc-200">Auto-Merge Confidence Threshold</span>
						<p class="mt-1 text-xs text-zinc-500">
							New claims with a confidence score above this will be automatically merged into the
							canonical SSOT.
						</p>
					</div>
					<span class="text-lg font-bold text-indigo-400">{ssotConfidence}%</span>
				</div>
				<input
					type="range"
					min="50"
					max="100"
					bind:value={ssotConfidence}
					class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-indigo-500 transition-colors hover:bg-zinc-700"
				/>
				<div class="flex justify-between font-mono text-[10px] text-zinc-500">
					<span>50% (High Review Load)</span>
					<span>100% (Manual Only)</span>
				</div>
			</div>

			<hr class="border-zinc-800/60" />

			<div class="flex items-start justify-between gap-4">
				<div class="pr-8">
					<h4 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
						<FileWarning class="h-4 w-4 shrink-0 text-rose-400" /> Require Review for All Contradictions
					</h4>
					<p class="mt-1 max-w-xl text-xs text-zinc-500">
						If disabled, the system will attempt to resolve conflicts using Source Priority rules
						automatically. If enabled, a human must resolve every conflict.
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={requireReview}
					aria-label="Require review for all contradictions"
					onclick={() => (requireReview = !requireReview)}
					class="relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {requireReview
						? 'border-indigo-500 bg-indigo-500'
						: 'border-zinc-700 bg-zinc-800'}"
				>
					<span
						class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {requireReview
							? 'translate-x-[22px]'
							: 'translate-x-0.5'}"
					></span>
				</button>
			</div>
		</div>
	</section>

	<!-- Source Priority -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<Scale class="h-5 w-5 text-indigo-400" /> Source Priority Ranking
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Drag and drop to set the priority order. Order determines which source wins during automated
				conflict resolution.
			</p>
		</div>
		<div class="p-6">
			<div
				class="divide-y divide-zinc-800/60 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50"
			>
				{#each sources as item, index (item.id)}
					<div
						animate:flip={{ duration: 200 }}
						draggable="true"
						ondragstart={() => (dragIndex = index)}
						ondragover={(e) => {
							e.preventDefault();
							overIndex = index;
						}}
						ondragleave={() => {
							if (overIndex === index) overIndex = null;
						}}
						ondrop={(e) => {
							e.preventDefault();
							onDrop(index);
						}}
						ondragend={() => {
							dragIndex = null;
							overIndex = null;
						}}
						role="listitem"
						class="flex cursor-grab items-center gap-4 p-4 transition-colors active:cursor-grabbing {overIndex ===
							index && dragIndex !== index
							? 'bg-indigo-500/10'
							: 'hover:bg-zinc-800'} {dragIndex === index ? 'opacity-50' : ''}"
					>
						<div class="text-zinc-600 transition-colors hover:text-zinc-400">
							<GripVertical class="h-5 w-5" />
						</div>
						<div class="w-6 text-xs font-bold text-zinc-500">{index + 1}</div>
						<div class="flex-1">
							<h4 class="text-sm font-medium text-zinc-200">{item.name}</h4>
							<p class="mt-0.5 text-xs text-zinc-500">{item.desc}</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<div class="relative flex justify-end pt-4 pb-12">
		{#if showSaved}
			<div
				in:fly={{ x: -20, duration: 250 }}
				out:fade={{ duration: 150 }}
				class="absolute top-6 right-[220px] flex items-center gap-2 text-sm font-medium text-emerald-400"
			>
				<CheckCircle2 class="h-4 w-4" />
				Saved Successfully
			</div>
		{/if}
		<button
			onclick={handleSave}
			disabled={isSaving}
			class="flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{#if isSaving}
				<Loader2 class="h-4 w-4 animate-spin" />
				Saving...
			{:else}
				<Save class="h-4 w-4" />
				Save Governance Policies
			{/if}
		</button>
	</div>
</div>
