<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Activity, FileText, ChevronLeft } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	// Page-specific comparison data — no dedicated API endpoint exists for the
	// source-comparison matrix, so the prototype's matrix is inlined as a local const.
	type CellTone = 'default' | 'agree' | 'conflict' | 'missing';
	type Cell = { text: string; tone?: CellTone };

	const columns = ['Book A: Basic Sciences', 'Book B: Clinical Endo', 'Book D: Board Pearls'] as const;

	const rows: { concept: string; cells: Cell[] }[] = [
		{
			concept: 'First-Line Diagnostic Test',
			cells: [
				{ text: 'Early morning serum cortisol' },
				{ text: 'Early morning cortisol + ACTH' },
				{ text: 'Synacthen (Cosyntropin) stimulation test', tone: 'agree' }
			]
		},
		{
			concept: 'Typical Presentation',
			cells: [
				{ text: 'Lethargy, weight loss, anorexia' },
				{ text: 'Hyperpigmentation, postural hypotension' },
				{ text: 'Salt craving, vitiligo, syncope' }
			]
		},
		{
			concept: 'Maintenance Therapy',
			cells: [
				{ text: 'Not covered', tone: 'missing' },
				{ text: 'Hydrocortisone twice daily (20mg/10mg)', tone: 'conflict' },
				{ text: 'Hydrocortisone thrice daily (10mg/5mg/5mg)', tone: 'conflict' }
			]
		}
	];

	const cellTones: Record<CellTone, string> = {
		default: '',
		agree: 'text-indigo-300 bg-indigo-500/10',
		conflict: 'text-rose-300 bg-rose-500/10',
		missing: 'text-zinc-500 italic'
	};
</script>

<div class="mx-auto max-w-6xl space-y-6" in:fade={{ duration: 200 }}>
	<a
		href="/research"
		class="flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	<header>
		<h1 class="glow-text flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
			<Activity class="h-6 w-6 text-indigo-400" />
			Source Comparison Matrix
		</h1>
		<p class="mt-1 text-sm text-zinc-400">
			Side-by-side analysis of how different textbooks define corresponding concepts.
		</p>
	</header>

	<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead
					class="border-b border-zinc-800 bg-zinc-900/50 font-mono text-xs text-zinc-400"
				>
					<tr>
						<th class="w-1/4 px-5 py-4 font-medium">Concept / Metric</th>
						{#each columns as col, i (col)}
							<th class="w-1/4 border-l border-zinc-800/50 px-5 py-4 font-medium">
								<span class="flex items-center justify-between gap-2">
									{col}
									{#if i === 0}<FileText class="h-4 w-4 shrink-0" />{/if}
								</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
					{#each rows as row (row.concept)}
						<tr class="transition-colors hover:bg-zinc-900/30">
							<td class="px-5 py-4 font-medium text-zinc-200">{row.concept}</td>
							{#each row.cells as cell, i (i)}
								<td
									class={cn(
										'border-l border-zinc-800/50 px-5 py-4',
										cellTones[cell.tone ?? 'default']
									)}
								>
									{cell.text}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
