<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
	import { GitMerge, Plus, Save, CheckCircle2, Loader2, ChevronLeft } from '@lucide/svelte';
	import { Button } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// The Argument Map is a page-specific builder with no dedicated API endpoint —
	// the premise/conclusion nodes are inlined from the prototype as local state.
	type NodeKind = 'premise' | 'evidence' | 'conclusion';
	type ArgNode = { id: string; kind: NodeKind; label: string; text: string; source?: string };

	let nodes = $state<ArgNode[]>([
		{
			id: 'n1',
			kind: 'premise',
			label: 'Premise 1',
			text: 'Tuberculosis is the primary etiology in developing regions.',
			source: 'bk-D'
		},
		{
			id: 'n2',
			kind: 'conclusion',
			label: 'Conclusion',
			text: 'Clinical suspicion must vary by geographic demography.'
		}
	]);

	const kindStyles: Record<NodeKind, { box: string; label: string }> = {
		premise: {
			box: 'bg-zinc-900/50 border-zinc-800 hover:border-indigo-500/50',
			label: 'text-zinc-500'
		},
		evidence: {
			box: 'bg-indigo-950/20 border-indigo-900/50 hover:border-indigo-500/50 shadow-[inset_0_0_20px_rgba(99,102,241,0.05)]',
			label: 'text-indigo-400'
		},
		conclusion: {
			box: 'bg-emerald-950/20 border-emerald-900/50 hover:border-emerald-500/50 shadow-[inset_0_0_20px_rgba(16,185,129,0.05)]',
			label: 'text-emerald-500'
		}
	};

	let premiseCount = $derived(nodes.filter((n) => n.kind === 'premise').length);

	function addNode() {
		const n = premiseCount + 1;
		// Insert a new premise just before the conclusion (or at the end if none).
		const conclusionIdx = nodes.findIndex((x) => x.kind === 'conclusion');
		const newNode: ArgNode = {
			id: `n${Date.now()}`,
			kind: 'premise',
			label: `Premise ${n}`,
			text: 'New premise — click to edit and cite a source.',
			source: '—'
		};
		if (conclusionIdx === -1) {
			nodes = [...nodes, newNode];
		} else {
			nodes = [...nodes.slice(0, conclusionIdx), newNode, ...nodes.slice(conclusionIdx)];
		}
	}

	type SaveState = 'idle' | 'saving' | 'saved';
	let saveState = $state<SaveState>('idle');
	let saveTimer: ReturnType<typeof setTimeout>;
	function saveMap() {
		if (saveState === 'saving') return;
		saveState = 'saving';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveState = 'saved';
			saveTimer = setTimeout(() => (saveState = 'idle'), 2000);
		}, 700);
	}
</script>

<div class="mx-auto flex min-h-[calc(100vh-6rem)] max-w-3xl flex-col items-center justify-center">
	<div class="w-full space-y-6 text-center" in:fade={{ duration: 200 }}>
		<a
			href="/research"
			class="mx-auto flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
		</a>

		<div
			class="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900"
		>
			<GitMerge class="h-8 w-8 text-indigo-400" />
		</div>

		<div>
			<h1 class="glow-text text-3xl font-bold tracking-tight text-zinc-100">Argument Map Builder</h1>
			<p class="mx-auto mt-2 max-w-lg text-sm text-zinc-400">
				Interactive workspace for constructing logical arguments from multiple source claims. Draw
				connections between premises, evidence nodes, and conclusions.
			</p>
		</div>

		<!-- Map canvas -->
		<div class="glass-panel mt-4 rounded-xl border border-dashed border-zinc-800 p-8">
			<div class="flex flex-col items-center">
				{#each nodes as node, i (node.id)}
					<div
						in:scale={{ duration: 200, start: 0.95 }}
						class={cn(
							'w-full max-w-xs cursor-pointer rounded-lg border p-4 text-left transition-colors',
							kindStyles[node.kind].box
						)}
					>
						<span
							class={cn(
								'mb-1 block font-mono text-[10px] tracking-wider uppercase',
								kindStyles[node.kind].label
							)}
						>
							{node.label}
						</span>
						<p class="text-sm text-zinc-300">{node.text}</p>
						{#if node.source}
							<div class="mt-2 text-[10px] text-indigo-400">Source: {node.source}</div>
						{/if}
					</div>

					{#if i < nodes.length - 1}
						<div class="my-1 h-8 w-px bg-zinc-700"></div>
					{/if}
				{/each}
			</div>
		</div>

		<!-- Actions -->
		<div class="flex flex-wrap items-center justify-center gap-4 pt-2">
			<Button variant="outline" onclick={addNode}>
				<Plus class="h-4 w-4" /> Add Node
			</Button>
			<Button onclick={saveMap} disabled={saveState === 'saving'}>
				{#if saveState === 'saving'}
					<Loader2 class="h-4 w-4 animate-spin" /> Saving…
				{:else if saveState === 'saved'}
					<CheckCircle2 class="h-4 w-4" /> Saved
				{:else}
					<Save class="h-4 w-4" /> Save Map
				{/if}
			</Button>
		</div>

		{#if saveState === 'saved'}
			<p in:fly={{ y: -4, duration: 150 }} class="text-xs text-emerald-400">
				Argument map saved to the Adrenal Insufficiency Synthesis board.
			</p>
		{/if}
	</div>
</div>
